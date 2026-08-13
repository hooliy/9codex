import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCT_CONTEXT_WINDOW,
  attachContextWindowMetadata,
  normalizeContextWindowMetadata,
  validateContextWindowMetadata,
} from "../lib/model-metadata.mjs";

test("declared windows retain provenance and a safe effective boundary", () => {
  const metadata = normalizeContextWindowMetadata({ context_window: 200_000 });

  assert.deepEqual(metadata, {
    upstream_declared: 200_000,
    product_fallback: PRODUCT_CONTEXT_WINDOW,
    safe_effective: 180_000,
    safe_fraction: 0.9,
    source: "upstream_declared",
    measurement_status: "unknown",
    measured: null,
  });
});

test("missing upstream context stays unknown instead of masquerading as product capacity", () => {
  const metadata = normalizeContextWindowMetadata({ id: "unreported" });

  assert.equal(metadata.upstream_declared, null);
  assert.equal(metadata.product_fallback, PRODUCT_CONTEXT_WINDOW);
  assert.equal(metadata.safe_effective, null);
  assert.equal(metadata.source, "product_fallback");
  assert.equal(metadata.measurement_status, "unknown");
  assert.notEqual(metadata.safe_effective, 945_000);
});

test("measurement becomes the trusted bound and serializes with legacy rows safely", () => {
  const row = attachContextWindowMetadata({ id: "measured", measured_context_window: 100_000 });

  assert.equal(row.context_window_metadata.measurement_status, "measured");
  assert.equal(row.context_window_metadata.safe_effective, 90_000);
  assert.equal(Object.hasOwn(row, "context_window"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(row)).context_window_metadata, row.context_window_metadata);
});

test("measurement tightens but never enlarges an upstream declaration", () => {
  const lower = normalizeContextWindowMetadata({
    context_window: 200_000,
    measured_context_window: 100_000,
  });
  const higher = normalizeContextWindowMetadata({
    context_window: 100_000,
    measured_context_window: 200_000,
  });

  assert.equal(lower.source, "measured");
  assert.equal(lower.safe_effective, 90_000);
  assert.equal(higher.source, "measured");
  assert.equal(higher.safe_effective, 90_000);
});

test("explicitly absent fallback is serializable as wholly unknown metadata", () => {
  const metadata = normalizeContextWindowMetadata({
    context_window_metadata: { product_fallback: null },
  });

  assert.equal(metadata.product_fallback, null);
  assert.equal(metadata.source, "unknown");
  assert.equal(metadata.safe_effective, null);
});

test("rejects unsupported safe-effective claims without trusted source metadata", () => {
  assert.throws(
    () => normalizeContextWindowMetadata({ context_window_metadata: { safe_effective: 945_000 } }),
    /requires measured or upstream_declared/i,
  );
});

test("validation rejects forged provenance and stale safe boundaries", () => {
  assert.throws(
    () => validateContextWindowMetadata({
      upstream_declared: 100_000,
      source: "product_fallback",
    }),
    /source does not match/i,
  );
  assert.throws(
    () => validateContextWindowMetadata({
      upstream_declared: 100_000,
      safe_effective: 80_000,
    }),
    /safe_effective does not match/i,
  );
});

/**
 * Context-window metadata deliberately records provenance.  A product default is
 * useful for display and diagnostics, but is never treated as an observed or
 * upstream-declared limit when making a request budget.
 */
export const PRODUCT_CONTEXT_WINDOW = 1_050_000;
export const DEFAULT_SAFE_CONTEXT_FRACTION = 0.9;

const WINDOW_SOURCES = new Set(["measured", "upstream_declared", "product_fallback", "unknown"]);
const MEASUREMENT_STATUSES = new Set(["measured", "unknown"]);

function optionalPositiveInteger(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer when provided`);
  }
  return value;
}

function fraction(value) {
  if (value === undefined) return DEFAULT_SAFE_CONTEXT_FRACTION;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new TypeError("safeFraction must be a number greater than 0 and at most 1");
  }
  return value;
}

/**
 * Normalize old scalar model rows and new provenance-bearing rows into the
 * serializable UI/API contract.
 *
 * `safe_effective` is only derived from a measured or upstream-declared
 * boundary. In particular, no value is derived from `product_fallback` alone.
 */
export function normalizeContextWindowMetadata(model = {}, options = {}) {
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    throw new TypeError("model metadata must be an object");
  }
  const looksLikeMetadata = [
    "upstream_declared",
    "product_fallback",
    "safe_effective",
    "safe_fraction",
    "measurement_status",
    "measured",
  ].some((field) => Object.hasOwn(model, field));
  const prior = model.context_window_metadata
    || model.contextWindowMetadata
    || (looksLikeMetadata ? model : {});
  const upstreamDeclared = optionalPositiveInteger(
    prior.upstream_declared ?? model.upstream_declared_context_window ?? model.context_window,
    "upstream_declared",
  );
  const productFallbackValue = prior.product_fallback === null
    ? null
    : prior.product_fallback ?? model.product_fallback_context_window ?? options.productFallback
      ?? PRODUCT_CONTEXT_WINDOW;
  const productFallback = optionalPositiveInteger(productFallbackValue, "product_fallback");
  const measured = optionalPositiveInteger(
    prior.measured ?? model.measured_context_window,
    "measured",
  );
  const safeFraction = fraction(prior.safe_fraction ?? options.safeFraction);
  const source = measured !== null
    ? "measured"
    : upstreamDeclared !== null
      ? "upstream_declared"
      : productFallback !== null
        ? "product_fallback"
        : "unknown";
  const measurementStatus = measured === null ? "unknown" : "measured";
  // When both values exist, use the lower bound. A probe must not make an
  // upstream-declared hard limit larger, and a lower measured limit must be
  // allowed to tighten that declaration.
  const trustedWindow = measured === null
    ? upstreamDeclared
    : upstreamDeclared === null
      ? measured
      : Math.min(measured, upstreamDeclared);
  const suppliedSafeEffective = optionalPositiveInteger(prior.safe_effective, "safe_effective");
  const calculatedSafeEffective = trustedWindow === null
    ? null
    : Math.max(1, Math.floor(trustedWindow * safeFraction));

  // A persisted safe value must not claim more than the trusted window. We
  // canonicalize it rather than allowing stale product defaults to leak in.
  if (suppliedSafeEffective !== null && trustedWindow !== null && suppliedSafeEffective > trustedWindow) {
    throw new RangeError("safe_effective cannot exceed the trusted context window");
  }
  if (suppliedSafeEffective !== null && trustedWindow === null) {
    throw new RangeError("safe_effective requires measured or upstream_declared context metadata");
  }

  return {
    upstream_declared: upstreamDeclared,
    product_fallback: productFallback,
    safe_effective: calculatedSafeEffective,
    safe_fraction: safeFraction,
    source,
    measurement_status: measurementStatus,
    measured,
  };
}

export function contextWindowForBudget(metadataOrModel, options = {}) {
  const metadata = normalizeContextWindowMetadata(metadataOrModel, options);
  return metadata.safe_effective;
}

export function isTrustedContextWindow(metadataOrModel, options = {}) {
  return contextWindowForBudget(metadataOrModel, options) !== null;
}

/** Return a model row with the normalized metadata attached for persistence. */
export function attachContextWindowMetadata(model, options = {}) {
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    throw new TypeError("model must be an object");
  }
  const context_window_metadata = normalizeContextWindowMetadata(model, options);
  return {
    ...structuredClone(model),
    context_window_metadata,
    // Preserve legacy scalar consumers only when it was actually declared.
    ...(context_window_metadata.upstream_declared === null
      ? {}
      : { context_window: context_window_metadata.upstream_declared }),
  };
}

export function validateContextWindowMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("context-window metadata must be an object");
  }
  if (Object.hasOwn(metadata, "source") && !WINDOW_SOURCES.has(metadata.source)) {
    throw new TypeError("invalid context-window metadata source");
  }
  if (
    Object.hasOwn(metadata, "measurement_status")
    && !MEASUREMENT_STATUSES.has(metadata.measurement_status)
  ) {
    throw new TypeError("invalid context-window measurement status");
  }
  const normalized = normalizeContextWindowMetadata({ context_window_metadata: metadata });
  if (Object.hasOwn(metadata, "source") && metadata.source !== normalized.source) {
    throw new TypeError("context-window metadata source does not match its values");
  }
  if (
    Object.hasOwn(metadata, "measurement_status")
    && metadata.measurement_status !== normalized.measurement_status
  ) {
    throw new TypeError("context-window measurement status does not match its values");
  }
  if (
    Object.hasOwn(metadata, "safe_effective")
    && metadata.safe_effective !== normalized.safe_effective
  ) {
    throw new TypeError("safe_effective does not match the trusted context window");
  }
  return normalized;
}

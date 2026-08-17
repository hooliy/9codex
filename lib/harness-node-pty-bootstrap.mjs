import { register } from "node:module";

const entry = process.env.NINECODEX_NODE_PTY_ENTRY;
if (entry) {
  register(
    new URL("./harness-node-pty-loader.mjs", import.meta.url),
    import.meta.url,
    { data: { entry } },
  );
}

const parentNodeOptions = process.env.NINECODEX_PARENT_NODE_OPTIONS;
if (parentNodeOptions) process.env.NODE_OPTIONS = parentNodeOptions;
else delete process.env.NODE_OPTIONS;
delete process.env.NINECODEX_NODE_PTY_ENTRY;
delete process.env.NINECODEX_PARENT_NODE_OPTIONS;

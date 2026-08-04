import readline from "node:readline/promises";

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function createInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });
}

export function normalizeBaseUrl(input) {
  let value = input.trim();
  if (value.length === 0) throw new Error("中转地址不能为空");
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`无效的中转地址: ${input}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`中转地址必须是 http(s): ${input}`);
  }
  if (!parsed.hostname || parsed.hostname === "localhost") {
    throw new Error("中转地址必须是可访问的远程地址");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export async function askBaseUrl(rl, current = "") {
  const prompt = current
    ? `中转地址 (回车使用 ${current}): `
    : "中转地址 (如 https://router.example.com/v1): ";
  const answer = await rl.question(prompt);
  return normalizeBaseUrl(answer || current);
}

export async function askApiKey(rl, current = "") {
  if (current) {
    const answer = (await rl.question("API Key (回车保留当前配置): ")).trim();
    return answer || current;
  }
  const key = (await rl.question("API Key: ")).trim();
  if (!key) throw new Error("API Key 不能为空");
  return key;
}

export async function askModelSelection(rl, models, {
  enabledIds = null,
  emptySelection = null,
  emptyLabel = "启用全部",
} = {}) {
  const enabledSet = Array.isArray(enabledIds) ? new Set(enabledIds) : null;
  console.log("\n从当前中转拉取到的模型:");
  models.forEach((model, index) => {
    const marker = enabledSet === null || enabledSet.has(model.id) ? "✓" : " ";
    console.log(`  [${index + 1}] ${marker} ${model.id}`);
  });
  console.log(`\n输入要启用的模型编号，逗号分隔（如 1,3,5）；留空 = ${emptyLabel}。`);
  const answer = (await rl.question("选择模型: ")).trim();
  if (answer.length === 0) return emptySelection;
  const indices = [...new Set(
    answer
      .split(/[,，\s]+/)
      .map((part) => Number.parseInt(part, 10))
      .filter((number) => Number.isInteger(number)),
  )];
  const unknown = indices.filter((number) => number < 1 || number > models.length);
  if (unknown.length > 0) throw new Error(`无效的模型编号: ${unknown.join(", ")}`);
  return indices.map((number) => models[number - 1].id);
}

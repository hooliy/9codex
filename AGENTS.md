# Repository Guidelines

## 发布规范

- npm 包固定发布命令：`npm publish --access public`。
- 发布前必须执行：`npm test`。
- 发布版本必须与 `package.json` 一致；发布后回读：
  `npm view @hooliy/9codex version dist.tarball dist.shasum --json`。
- 使用本机用户级 npm 凭据：`~/.npmrc`。禁止把 token 写入仓库、提交 Git、打印日志或回复消息。
- 已配置有效 npm token 时，直接发布；不得重复要求用户登录或确认。
- npm 发布失败时，保留原始错误；不得伪称发布成功。

## 版本流程

```bash
npm test
npm version <version> --no-git-tag-version
git add package.json package-lock.json
git commit -m "release: v<version>"
git tag v<version>
git push origin main --follow-tags
npm publish --access public
npm view @hooliy/9codex version dist.tarball dist.shasum --json
```

## 安全边界

- `.npmrc` 仅存放在用户目录；权限保持用户私有。
- 任何命令输出、测试证据、提交信息不得包含 npm token。
- Token 失效、权限不足或 2FA 阻断时，停止发布并报告具体错误。

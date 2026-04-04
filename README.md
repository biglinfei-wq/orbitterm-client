# OrbitTerm Client (Open Source)

OrbitTerm Client 是 OrbitTerm 的开源客户端代码仓库，提供：
- 终端连接（SSH）
- 文件传输（SFTP）
- 本地金库与客户端设置
- Windows/macOS 安装包发布

## 商业与开源边界
- 本仓库仅包含客户端代码。
- 同步后端、管理端、风控与授权策略属于服务端商业模块，不在本仓库公开。
- 付费能力是否可用，以服务端返回的能力位为准。

## 本地构建
1. 安装 Node.js、Rust、Tauri 依赖。
2. 执行：
   - `npm ci`
   - `npm run build:macos:arm64` 或 `npm run build:macos:x64`
3. 安装包输出目录：
   - `src-tauri/target/<target>/release/bundle`

## 下载发布
- Release: <https://github.com/biglinfei-wq/orbitterm-client/releases>
- 版本索引：`releases/latest.json`

## 安全报告
请参考仓库内 `SECURITY.md`。

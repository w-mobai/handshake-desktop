# DeepSeek Desktop

一个用于 Windows 和 macOS 的局域网文件夹共享应用，支持设备密码配对、
文件上传下载、双向编辑，以及挂载到 Finder 或 Windows 文件资源管理器。

## 开发运行

```bash
npm install
npm run dev
```

## 检查

```bash
npm run check
```

## 打包 macOS DMG

```bash
npm run build:mac
```

生成文件在：

```text
dist/
```

## 打包 Windows 安装程序

建议在 Windows 10/11 x64 电脑上执行：

```powershell
npm install
npm run build:win
```

安装程序生成在 `dist/`，文件名类似：

```text
DeepSeek Desktop-0.1.0-Windows-x64-Setup.exe
```

## 跨平台共享

1. 两台电脑连接同一个局域网，并分别运行 Desktop Share。
2. 在共享端编辑电脑名称、设置至少 6 位共享密码，然后添加共享文件夹。
3. 系统首次弹出防火墙提示时，允许应用访问“专用网络”。
4. 在另一台电脑点击“刷新”，选择目标电脑并输入共享密码配对。
5. 点击“挂载”，共享目录会出现在 Finder 或 Windows 文件资源管理器中。

支持 Windows 与 Mac、Mac 与 Mac，以及 Windows 与 Windows 之间共享。挂载后
双方可以直接新建、修改、移动和删除共享内容。

如果没有自动发现，可以在 Windows 运行 `ipconfig` 查找 IPv4 地址，然后在
Mac 浏览器打开 `http://Windows-IP:8787`，例如
`http://192.168.1.20:8787`。

共享密码使用系统安全存储加密保存。当前传输面向可信局域网，尚未启用 TLS；
请不要在公共 Wi-Fi 中开启共享，也不要复用系统登录密码或重要账户密码。

# Opencode_Plugin-AUTO_MODEL

为 [Opencode](https://github.com/opencode-ai/opencode) 开发的第三方模型列表自动获取与注入插件。

本插件可以让你在配置自定义服务商（如各种 OpenAI 兼容的代理、中转 API、本地 Ollama 等）时，**无需手动填写冗长的模型列表**。插件会在后台自动调用 API 获取模型，并利用启发式规则和 `models.dev` 数据智能补全上下文长度、多模态支持（视觉、文档）以及推理模型标签。

## 特性

- **自动发现**：支持所有标准的 OpenAI 兼容 `/v1/models` 端点。
- **无缝鉴权**：自动读取 Opencode 本地的 `auth.json`，无需在配置中明文暴露 API Key。
- **静默执行**：纯后台运行，不污染 Opencode 的 TUI 终端界面。
- **详细日志**：执行状态与错误信息自动归档至本地日志文件，方便排查网络问题。

## 安装方法

1. 前往本仓库的 [Releases 页面](../../releases/latest) 下载最新编译好的 `auto-models.js` 文件。
2. 将文件保存到你的本地目录，例如：
   - Windows: `C:\Users\YourName\.config\opencode\plugins\auto-models.js`
   - WSL/Linux: `/home/YourName/.config/opencode/plugins/auto-models.js`

3. 修改/新增配置

打开你的 Opencode 配置文件（通常位于 `~/.config/opencode/opencode.jsonc`，若不存在，请先新建一个），在 `plugin` 数组中引入本插件：

```jsonc
{
  "plugin": [
    [
      // 插件的本地绝对路径 (Windows 路径注意使用 file:/// 和正斜杠)
      "file:///C:/Users/YourName/.config/opencode/plugins/auto-models.js",
      {
        "providers": [
          {
            "id": "my-proxy",
            "name": "My API Proxy",
            "baseURL": "[https://api.your-proxy.com/v1](https://api.your-proxy.com/v1)"
            // "apiKey": "sk-xxx" // 可选：如果 auth.json 中已配置同 id 的 key，此处可省略
          },
          {
            "id": "local-ollama",
            "name": "Ollama Local",
            "baseURL": "http://127.0.0.1:11434/v1"
          }
        ]
      }
    ]
  ]
}
```

4. 配置API Key
使用opencode-tui中的/connect命令-Other Custom  Provider-Provider id请使用和`opencode.jsonc`相同的id-输入API Key。

或者，你也可以直接编辑`~/.local/share/opencode/auth.json`添加API Key。

## 本地开发与构建
确保你的系统已安装 Bun。

```Bash
# 克隆仓库
git clone [https://github.com/yourusername/opencode-auto-models.git](https://github.com/yourusername/opencode-auto-models.git)
cd opencode-auto-models

# 安装依赖
bun install

# 构建插件
bun build src/index.ts --outfile=auto-models.js --target node --external @opencode-ai/plugin
```

## 日志排查
如果模型没有正常加载，可以查看插件生成的日志文件：

路径：`~/.config/opencode/opencode-auto-models.log`

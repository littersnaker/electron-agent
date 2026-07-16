// 1. 工具列表：将原来的强行写入，升级为“提议修改(Diff)”
export const tools = [
  {
    type: "function",
    function: {
      name: "propose_file_change",
      // 🌟 核心改动：在描述中加入极其强烈的命令，诱导大模型在生成概率上绝对倾向于调用工具
      description:
        "【绝对强制使用】当用户要求修改、优化、重构或修复某个本地文件时，你必须调用此工具来提交新代码。严禁直接在聊天文本中回复修改后的完整代码块！",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "相对于项目根目录的文件路径，例如 'app/page.tsx'",
          },
          fileContent: {
            type: "string",
            description:
              "修改后的完整新代码内容，不要包含 Markdown 的 \`\`\` 标记",
          },
        },
        required: ["filePath", "fileContent"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file_from_disk",
      description:
        "读取本地项目特定路径下的文件源码内容。在修改文件前，如果不知道原内容，必须先调用此工具读取。",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "相对于项目根目录的文件路径",
          },
        },
        required: ["filePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_pdf_from_disk",
      description:
        "读取本地 PDF 文件并提取其中的文本内容。当用户询问 PDF 文档内容时使用。",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "PDF 文件的路径" },
        },
        required: ["filePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_local_time",
      description:
        "获取用户当前系统或所在地区的本地时间与日期。当用户询问‘现在几点’、‘今天几号’或涉及时间敏感型信息时使用。",
      parameters: {
        type: "object",
        properties: {}, // 无需传参，直接返回当前系统时间
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_codebase",
      description: "搜索整个项目中的代码、函数、组件、变量或关键字。",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description: "要搜索的关键字",
          },
        },
        required: ["keyword"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_terminal_command",
    description: 
        "在当前工作目录下执行终端命令（如 npm, git, npx 等）。" +
        "【⛔ 致命警告：当前是无头(Headless)环境，不支持任何交互！" +
        "任何会触发 CLI 询问（Prompt/Select）的命令（如基础的 taro init, create-vue）都会导致系统死锁。" +
        "创建项目必须使用所有非交互式 Flags（例如 --template, --typescript, -y, --force 等）跳过交互环节！】",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "要执行的具体 shell 命令",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "查看项目目录结构，用于分析项目文件组织。",
      parameters: {
        type: "object",
        properties: {
          dirPath: {
            type: "string",
            description: "目录路径，默认 '.'",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_diff",
      description: "比较原文件和pending文件差异",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
          },
        },
        required: ["filePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_file_change",
      description: "将 pending 文件正式覆盖到原文件",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
          },
        },
        required: ["filePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_code_outline",
      description: "提取单个文件的代码大纲（函数名、类名、接口、导出项），而不读取完整代码体。适合在处理超大文件或快速了解文件结构时使用。",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "相对于项目根目录的文件路径，例如 'app/page.tsx' 或 'main/index.ts'",
          },
        },
        required: ["filePath"],
      },
    },
  },
];

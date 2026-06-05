export // 1. 工具列表：将原来的强行写入，升级为“提议修改(Diff)”
const tools = [
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
      description: "读取本地 PDF 文件并提取其中的文本内容。当用户询问 PDF 文档内容时使用。",
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
      description: "获取用户当前系统或所在地区的本地时间与日期。当用户询问‘现在几点’、‘今天几号’或涉及时间敏感型信息时使用。",
      parameters: {
        type: "object",
        properties: {}, // 无需传参，直接返回当前系统时间
        required: [],
      },
    },
  },
];
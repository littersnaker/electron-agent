/**
 * 提供给 Code Agent 的工具定义。
 *
 * 设计原则：
 * 1. description 只描述当前执行器真实具备的能力；
 * 2. 明确工具的使用时机、前置条件、输出边界和禁止事项；
 * 3. 文件修改必须遵循 read -> propose -> diff -> apply 的闭环；
 * 4. 不向模型暴露尚未实现的工具，避免产生无效 tool call。
 */
export const tools = [
  {
    type: "function",
    function: {
      name: "search_project_index",
      description:
        "查询当前已绑定项目的 SQLite 代码索引，用于快速定位可能相关的文件、符号、组件、API 或配置项。该工具只查询已有索引，不读取磁盘上的完整源码；找到候选文件后，必须使用 read_file_from_disk 获取最新且准确的文件内容。仅在当前会话已经绑定 projectId 时使用；不要把整段用户需求作为 query。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "简短、明确的检索词，例如文件名、函数名、类名、组件名、接口名、配置键或相关概念。优先传 1～3 个关键词，不要传长篇自然语言。",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description:
        "列出指定目录的直接子项，用于确认目录是否存在、了解当前层级结构或定位下一步要读取的文件。返回内容最多包含 40 个子项，只包含名称和 file/directory 类型，不递归展开，也不读取文件内容。需要查看更深层目录时，应对具体子目录再次调用本工具。",
      parameters: {
        type: "object",
        properties: {
          dirPath: {
            type: "string",
            description:
              "相对于当前项目工作目录的目录路径，例如 '.'、'src'、'src/components'。省略时默认使用项目根目录 '.'；不要传文件路径。",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_codebase",
      description:
        "在当前项目工作目录中递归执行不区分大小写的纯文本关键字搜索，用于项目索引未命中、索引不可用或需要从磁盘重新定位文件时使用。当前只扫描 .ts、.tsx、.js、.jsx、.json、.md 文件，跳过 .git、node_modules、.next、dist、build、out，并最多返回 20 个命中文件路径；不会返回命中行或源码片段。找到候选文件后，应继续使用 read_file_from_disk 确认内容。",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description:
              "要原样搜索的单个关键字或短语，例如 'interactiveRequest'、'run_terminal_command'、'DashboardPage'。不是正则表达式，不要传整段任务描述。",
          },
        },
        required: ["keyword"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file_from_disk",
      description:
        "完整读取当前项目中的一个 UTF-8 文本文件。修改现有文件前必须先调用本工具，确保后续修改基于真实完整内容，而不是根据文件名或片段猜测。该工具不适用于目录、PDF、图片、压缩包或其他二进制文件；路径不确定时应先使用 search_project_index、search_codebase 或 list_directory 定位。",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "相对于当前项目工作目录的准确文件路径，例如 'app/page.tsx'、'src/main.ts'。不要追加 '.pending'，不要传目录路径，也不要使用 Markdown 引号或代码块。",
          },
        },
        required: ["filePath"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_file_change",
      description:
        "为单个文件提交一份完整的新内容，但暂不覆盖正式文件。工具会把 fileContent 写入同目录下的 '<filePath>.pending'，并自动返回正式文件与 pending 文件之间的简化差异。修改已有文件时，必须先使用 read_file_from_disk 读取原文件；fileContent 必须包含该文件修改后的全部最终内容，而不是局部片段、补丁、伪代码或解释。每次调用只处理一个文件。",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "相对于当前项目工作目录的目标文件路径，例如 'app/page.tsx'。传正式文件路径，不要带 '.pending' 后缀。对于新文件，可直接传计划创建的路径。",
          },
          fileContent: {
            type: "string",
            description:
              "目标文件修改后的完整 UTF-8 内容。不得省略未修改部分，不得使用 '其余不变'，不得包含 Markdown 三反引号、文件名标题、diff 标记或额外说明。",
          },
        },
        required: ["filePath", "fileContent"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_diff",
      description:
        "查看正式文件与对应 '<filePath>.pending' 文件之间的简化逐行差异，不会修改任何文件。只能在 propose_file_change 已成功生成 pending 文件后使用。返回格式是带原行号的 '-旧行' 和 '+新行'，不是可直接应用的标准 unified diff；当前实现要求正式文件已经存在，因此新建文件可能返回“原文件不存在”。",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "要比较的正式文件路径，例如 'src/main.ts'。不要传 '<filePath>.pending'。",
          },
        },
        required: ["filePath"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_file_change",
      description:
        "正式应用一个已经生成的文件变更：把 '<filePath>.pending' 完整覆盖到目标文件，然后删除 pending 文件。仅在 propose_file_change 已成功、差异已经通过 get_diff 检查，并且当前工作流允许应用该修改时调用。该操作不是局部 patch，也不会自动保留正式文件的旧内容；如果 pending 内容不完整，会导致目标文件内容丢失。",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "要应用变更的正式文件路径，例如 'src/main.ts'。不要传 '.pending' 后缀；必须与 propose_file_change 使用的 filePath 完全一致。",
          },
        },
        required: ["filePath"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_terminal_command",
      description:
        "在当前项目工作目录中执行一条真实、可直接运行的 shell/CLI 命令。普通命令使用同步执行并在约 20 秒后超时；脚手架和其他已识别的交互命令（例如 vue create、npm create/init、npx create-*、pnpm create/dlx、yarn create、bun create、ng new、nest new、taro init、cargo generate、dotnet new、python/py manage.py）会进入持久 PTY 会话。PTY 命令出现 confirm、select、multiselect 或 input 提示时，会返回 interactiveRequest 并暂停等待用户选择；此时不得重新执行原命令，必须恢复同一个终端会话。不要用本工具读取或直接改写源码文件，也不要执行与当前任务无关、破坏性或未经用户授权的命令。",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "一条具体、可直接执行的 CLI 命令，例如 'pnpm build'、'git status'、'npm create vite@latest demo'。只传命令本身，不要传自然语言需求、角色提示、Markdown 代码块、说明文字或多条互不相关的命令。",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_local_time",
      description:
        "返回服务器当前时间，并固定按 Asia/Shanghai 时区格式化。仅在任务确实需要中国标准时间时使用；该结果不代表用户设备时区、浏览器时区或项目所在机器的本地时区。无需传入参数。",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
] as const;

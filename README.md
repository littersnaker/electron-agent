# Agent Workspace

A local AI Agent workspace built with **Electron + Next.js**, combining general Q&A, local code collaboration, and AI media generation in one desktop application.

[中文文档](./README_CN.md) | English

## Overview

Agent Workspace provides three independent work modes:

- **QA Agent** — general Q&A, document analysis, image understanding, and multimodal conversations.
- **Code Agent** — local project indexing, code search, task planning, file modification, terminal execution, validation, and review.
- **Media Agent** — text-to-image, image editing, text-to-video, image-to-video, reference-to-video, and video editing through Alibaba Cloud Model Studio / DashScope models.

Media generation is intentionally separated from `/api/qa` and `/api/chat`. Image and video models use their own request, task polling, progress, preview, persistence, and download pipeline.

## Highlights

### QA Agent

- General conversations and reasoning
- Document and PDF analysis
- Image understanding with vision-capable chat models
- Streaming responses
- Token usage display
- Independent sessions that do not read local projects by default

### Code Agent

- Local workspace management
- Project indexing and semantic code search
- Context retrieval and RAG
- Multi-Agent task orchestration
- Diff / patch based file modification
- Terminal command execution
- Lint, build, and test validation
- SQLite session persistence

### Media Agent

- Text-to-image
- Upload image + natural-language image editing
- Text-to-video
- Image-to-video
- Reference-image-to-video
- Video editing
- Generated image and video preview
- Direct download from the conversation
- Media usage / quota display
- Dedicated Media Agent and Reviewer progress states

## Precise Image Editing

The Media Agent includes a protected image-editing pipeline designed to reduce over-editing, duplicated elements, ghosting, and layout drift.

Available edit strategies:

- **Precise Edit** — preserves the original composition and changes only the requested area. Recommended for UI screenshots, ecommerce images, titles, buttons, labels, and product details.
- **Balanced Edit** — preserves the main structure while allowing moderate local redraw.
- **Creative Redesign** — allows broad visual changes and composition redesign.

The precise-edit pipeline can apply:

- Strong original-image preservation instructions
- Negative prompts for duplicated objects, double edges, ghosting, and unwanted text
- Prompt expansion control
- Input aspect-ratio preservation
- Result quality review
- One automatic retry when a result is considered unreliable

> Generative image models may still produce imperfect typography. For production UI, ecommerce prices, brand names, and long Chinese text, the recommended workflow is to generate the visual background first and render final text with Canvas, SVG, or another deterministic layout layer.

## Supported Media Modes

The media model catalog is defined in `app/lib/media/catalog.ts`.

Current modes:

```text
text-to-image
image-edit
text-to-video
image-to-video
reference-to-video
video-edit
```

Example registered models include:

- Qwen-Image generation and editing models
- Wan text-to-video models
- Wan image-to-video models
- Wan reference-to-video models
- HappyHorse reference-to-video and video-edit models

Model availability depends on the models enabled in your Alibaba Cloud Model Studio account and region.

## Agent Architecture

```text
User Request
      |
Request Router
      |
Orchestrator
      |
+-----+----------------+----------------+
|                      |                |
QA Agent           Code Agent       Media Agent
|                      |                |
Vision / RAG       Planner          Media Provider
LLM Gateway        Researcher       Async Task Polling
                   Coding Agent     Quality Review
                   Terminal         Preview / Download
                   Reviewer
```

### Agent Roles

| Agent | Responsibility |
|---|---|
| Orchestrator | Classifies requests, coordinates execution, and summarizes results |
| Planner | Breaks complex work into executable stages |
| Researcher | Retrieves project files, indexes, documents, and related context |
| Coding Agent | Creates and modifies code changes |
| Media Agent | Generates or edits images and videos |
| Reviewer | Reviews code or generated media results |
| Terminal Agent | Executes commands and reads terminal output |

## LLM and Media Gateway

Agent logic is separated from model providers.

```text
Agent Runtime
      |
Gateway / Router
      |
+-----------+-----------+-----------+
|           |           |           |
Qwen      OpenAI      Gemini     DashScope Media
```

Capabilities include:

- Provider abstraction
- Model catalog and model routing
- Prompt registry
- Streaming text generation
- Vision input
- Token accounting
- Media usage accounting
- Image / video task polling
- Generated media persistence and download

## Tech Stack

### Desktop

- Electron 43
- Node.js

### Frontend

- Next.js 16
- React 19
- TypeScript 6
- Tailwind CSS 4

### AI

- LangGraph
- LangChain Core
- Multi-provider LLM gateway
- RAG
- Alibaba Cloud Model Studio / DashScope media APIs

### Storage

- SQLite

## Project Structure

```text
app/
├── api/
│   ├── chat/
│   ├── qa/
│   ├── media/
│   │   └── generate/
│   └── workspace/
├── component/
│   ├── AgentPanel.tsx
│   ├── ChatComposer.tsx
│   ├── ChatList.tsx
│   ├── TaskPlanningPanel.tsx
│   └── WorkspaceHeader.tsx
├── hooks/
│   ├── useAgentCoordinator.ts
│   ├── useChatStream.ts
│   └── useWorkspaceController.ts
├── lib/
│   ├── llm/
│   ├── media/
│   │   ├── catalog.ts
│   │   ├── dashscope.ts
│   │   ├── prompt.ts
│   │   ├── edit-policy.ts
│   │   └── quality-checker.ts
│   ├── rag/
│   └── server/
└── utils/

electron/
├── main.ts
└── preload.ts
```

Some filenames may differ slightly between branches. Use the files in your current project as the source of truth.

## Requirements

- Node.js 20 or later
- pnpm
- An Alibaba Cloud Model Studio / DashScope API key for Qwen and media generation
- Optional OpenAI and Gemini keys for additional chat providers

## Installation

```bash
pnpm install
```

## Web Development

```bash
pnpm dev
```

Open the local Next.js URL shown in the terminal.

## Electron Development

```bash
pnpm electron:dev
```

## Validation

```bash
pnpm lint
pnpm build
```

## Packaging

```bash
pnpm electron:package
pnpm electron:make
```

## Environment Variables

Create `.env.local` in the project root:

```env
# Alibaba Cloud Model Studio / DashScope
DASHSCOPE_API_KEY=

# Optional custom workspace endpoint
DASHSCOPE_API_BASE=https://dashscope.aliyuncs.com

# Optional endpoint used for temporary media uploads
DASHSCOPE_UPLOAD_API_BASE=https://dashscope.aliyuncs.com

# Optional chat providers
OPENAI_API_KEY=
GEMINI_API_KEY=

# Optional local persistence directory
AGENT_DATA_DIR=
```

Do not commit real API keys.

## Usage

### Generate an Image

1. Create or open a **Media Agent** session.
2. Select **Text to Image**.
3. Choose a compatible Qwen-Image model.
4. Enter the visual requirements.
5. Click **Generate**.
6. Preview and download the result from the Assistant message.

### Edit an Uploaded Image

1. Select **Image Edit**.
2. Upload the source image.
3. Select **Precise Edit** for UI, ecommerce, or text-only modifications.
4. Describe only the required change.
5. Generate and review the result.

A good precise-edit instruction is:

```text
Replace only the top title with “New Product”. Preserve every other pixel,
object position, lighting, color, shadow, card, icon, and background. Do not
redraw the whole image. Do not add duplicate elements, ghosting, or new text.
```

### Generate a Video

1. Select the required video mode.
2. Upload a source image or video when required.
3. Choose a compatible Wan or HappyHorse model.
4. Submit the task.
5. Wait for asynchronous task polling to complete.
6. Preview or download the result.

## Usage and Progress Display

- Text requests display prompt tokens, completion tokens, and total tokens.
- Media requests display the image or video usage count when available.
- The right-side Agent panel shows Orchestrator, Media Agent, Reviewer, and related progress.
- Finished media tasks should reach 100% instead of remaining at 0%.

## Troubleshooting

### Generated text looks incorrect or unreadable

This is a model limitation rather than a browser rendering issue.

Recommended solutions:

- Ask the model to generate no text and leave a clean text area.
- Keep model-generated text short.
- Add final text with Canvas, SVG, HTML, or a design tool.
- Avoid asking the model to generate dense dashboards or long Chinese paragraphs directly inside the image.

### Image editing creates ghosting or duplicated elements

- Use **Precise Edit**.
- Describe one local modification at a time.
- Explicitly state what must remain unchanged.
- Avoid creative words such as “redesign”, “rebuild”, or “make it more dramatic” when only a small edit is needed.
- Confirm that the selected model supports image editing rather than only image generation.

### Media progress remains at 0%

Check that:

- The session mode is `image` / Media Agent.
- `Media Agent` exists in `AgentPanel.tsx`.
- The media request updates `useAgentCoordinator` before, during, and after the API call.
- The completion path sets Media Agent and Orchestrator to `completed` with progress `100`.

### Usage information is missing

Check that:

- Text SSE responses send `USAGE` packets.
- Media API responses include a `usage` object or the frontend creates a media-count fallback.
- `WorkspaceHeader.tsx` reads `totalTokens ?? total`.

## Security Notes

Do not include the following in release archives or source control:

```text
.env.local
.env.sentry-build-plugin
.agent-data/
node_modules/
.next/
```

For production media storage, use your own OSS, S3, or R2 bucket instead of relying only on temporary provider URLs.

## Screenshots

The repository currently includes example screenshots such as:

![alt text](image.png)
![alt text](image-1.png)
![alt text](image-2.png)
![alt text](image-3.png)

## Roadmap

- Deterministic text overlay for ecommerce and UI images
- Mask-based local editing
- Media task history and retry management
- Object storage integration
- Dynamic Agent graphs
- Plugin system
- Long-term memory
- More autonomous coding workflows

## License

MIT License
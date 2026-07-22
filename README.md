# Agent Workspace

A local AI Agent development workspace built with Electron + Next.js.

[中文版本](./README_CN.md) \| English

## Overview

Agent Workspace is a local AI coding assistant that combines desktop
applications, Web UI, code intelligence, and Agent Runtime.

It provides a development workflow similar to Cursor or Claude Code:

- Understand local projects
- Search and analyze code
- Plan tasks
- Modify source files
- Execute tools
- Review changes
- Continue long-running tasks

## Features

- Electron desktop application
- Next.js App Router interface
- QA Agent and Code Agent modes
- Workspace management
- Local project indexing
- Code search and context retrieval
- Diff and Patch based code modification
- Terminal tool execution
- SSE streaming interaction
- SQLite persistence
- Dark / Light themes

## Agent Workflow

```text
User Request
      |
Request Router
      |
Orchestrator
      |
Search + Memory + File Context
      |
Planner
      |
Modify Worker
      |
Reviewer
      |
Lint / Build / Test
      |
Final Report
```

## Multi-Agent System

Agent Responsibility

---

Orchestrator Task coordination
Planner Task decomposition
Researcher Project context retrieval
Coder Code modification
Reviewer Validation
Terminal Command execution

## LLM Gateway

Agent Workspace separates Agent logic from model providers.

Supported providers:

- Qwen
- OpenAI
- Gemini

Architecture:

```text
Agent Runtime
      |
 LLM Gateway
      |
+-----+-----+-----+
|     |     |
Qwen OpenAI Gemini
```

Features:

- Provider abstraction
- Model Router
- Prompt Registry
- Multi-model switching
- Token usage tracking
- Streaming generation

## RAG

Supports retrieval augmented generation:

- Document parsing
- Text chunking
- Context retrieval
- Relevant content injection
- Long document optimization

## Tech Stack

### Desktop

- Electron
- Node.js

### Frontend

- Next.js
- React
- TypeScript
- Tailwind CSS

### AI

- LangGraph
- LangChain Core
- LLM Gateway
- RAG

### Storage

- SQLite

## Project Structure

```text
app/
 ├── api/
 ├── component/
 ├── hooks/
 └── lib/
      ├── llm/
      │    ├── providers/
      │    ├── prompts/
      │    ├── model-router.ts
      │    └── gateway.ts
      └── rag/

electron/
 ├── main.ts
 └── preload.ts
```

## Screenshots

```text
docs/images/
```

![alt text](d47990f7-6281-4621-aca8-6d5ecf2fe8be.png)
![alt text](35fb0739-d172-451d-9f27-45ea3059dd09.png)
![alt text](3d9487f9-811b-4d0b-904f-65f8499ceb15.png)
![alt text](ee262c49-4c84-4531-8134-b211d4960351.png)
![alt text](6ca03ec3-ba5f-4fe5-b6b4-1869f46ebec8.png)

## Installation

```bash
pnpm install
```

## Development

```bash
pnpm dev
pnpm electron:dev
```

## Environment Variables

```env
DASHSCOPE_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
AGENT_DATA_DIR=
```

## Roadmap

Completed:

- Desktop Application
- Workspace Management
- Code Agent
- Multi-Agent Workflow
- Tool Calling
- SSE Streaming
- RAG
- LLM Provider Gateway
- Multi Model Routing
- Prompt Registry

Planned:

- Plugin System
- Dynamic Agent Graph
- Long-term Memory
- Autonomous Coding Workflow

## License

MIT License

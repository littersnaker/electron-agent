// src/components/ApiKeyModal.tsx
import { useState } from "react";

interface Props {
  isOpen: boolean;
  onSave: (key: string) => void;
}

export default function ApiKeyModal({ isOpen, onSave }: Props) {
  const [key, setKey] = useState("");

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="w-100 p-6 rounded-xl border border-[#26263a] shadow-2xl"
        style={{ background: "#16161f" }}
      >
        <h2 className="text-lg font-bold text-white mb-2">配置 API Key</h2>
        <p className="text-sm text-gray-400 mb-4">
          请输入你的 千问 API Key。该 Key 将保存至本地，仅用于发送请求。或者用我的 Key
        </p>
        <input
          type="password"
          className="w-full px-4 py-2 mb-4 rounded-lg outline-none text-white border border-[#26263a]"
          style={{ background: "#12121a" }}
          placeholder="sk-..."
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <button
          onClick={() => onSave(key)}
          disabled={!key.trim()}
          className="w-full py-2 cursor-pointer bg-linear-to-r from-[#a855f7] to-[#6366f1] text-white rounded-lg font-medium hover:opacity-90 disabled:opacity-50"
        >
          保存并使用
        </button>
        <button
          onClick={() => onSave(key)}
          className="w-full py-2 cursor-pointer mt-1.5 bg-linear-to-r from-[#a855f7] to-[#6366f1] text-white rounded-lg font-medium hover:opacity-90 disabled:opacity-50"
        >
          进入使用(用我所剩无几的key)
        </button>
      </div>
    </div>
  );
}

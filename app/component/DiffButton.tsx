// components/DiffButton.tsx
export default function DiffButton({ data }: { data: { original: string; pending: string; message: string } }) {
  const handleCompare = () => {
    // 假设你通过 window.vscode 接口与 VS Code 插件环境通信
    if (window.vscode) {
      window.vscode.postMessage({
        command: 'openDiff',
        original: data.original,
        modified: data.pending,
      });
    } else {
      alert(`请手动对比：${data.original} 和 ${data.pending}`);
    }
  };

  return (
    <button 
      onClick={handleCompare}
      style={{
        padding: '8px 16px',
        backgroundColor: '#0070f3',
        color: 'white',
        borderRadius: '5px',
        border: 'none',
        cursor: 'pointer',
        marginTop: '10px'
      }}
    >
      📂 点击分屏对比 (Compare Selected)
    </button>
  );
}
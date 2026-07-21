import React, { useState, useRef, useCallback, useMemo } from 'react';

// ==========================================
// 1. 核心虚拟列表组件
// ==========================================
interface VirtualListProps<T> {
  data: T[];
  itemHeight: number; // 每项的固定高度
  containerHeight: number; // 容器可视高度
  renderItem: (item: T, index: number) => React.ReactNode;
}

function VirtualList<T>({ data, itemHeight, containerHeight, renderItem }: VirtualListProps<T>) {
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // 监听滚动事件
  const handleScroll = useCallback(() => {
    if (containerRef.current) {
      setScrollTop(containerRef.current.scrollTop);
    }
  }, []);

  // 计算可视区域的起始索引
  const startIndex = useMemo(() => {
    return Math.max(0, Math.floor(scrollTop / itemHeight) - 2); // 预渲染2条，防止白屏
  }, [scrollTop, itemHeight]);

  // 计算可视区域的结束索引
  const endIndex = useMemo(() => {
    const visibleCount = Math.ceil(containerHeight / itemHeight);
    return Math.min(data.length - 1, startIndex + visibleCount + 4); // 多渲染几条作为缓冲
  }, [startIndex, containerHeight, itemHeight, data.length]);

  // 获取当前需要渲染的数据
  const visibleData = useMemo(() => {
    return data.slice(startIndex, endIndex + 1);
  }, [data, startIndex, endIndex]);

  // 列表总高度（用于撑开滚动条）
  const totalHeight = data.length * itemHeight;
  
  // 偏移量（将可视内容推到正确的位置）
  const offsetY = startIndex * itemHeight;

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      style={{ height: containerHeight, overflowY: 'auto' }}
      className="border border-gray-200 rounded-lg shadow-sm relative bg-white"
    >
      {/* 幽灵元素：用于撑开容器，产生真实的滚动条 */}
      <div style={{ height: totalHeight, position: 'relative' }}>
        {/* 实际渲染的内容区域：使用绝对定位和 transform 进行偏移 */}
        <div
          style={{
            transform: `translateY(${offsetY}px)`,
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
          }}
        >
          {visibleData.map((item, index) => (
            <div
              key={startIndex + index}
              style={{ height: itemHeight }}
              className="flex items-center px-4 border-b border-gray-100 hover:bg-blue-50 transition-colors duration-150"
            >
              {renderItem(item, startIndex + index)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ==========================================
// 2. 测试与演示页面
// ==========================================
export default function VirtualListDemo() {
  // 生成 10,000 条测试数据
  const mockData = useMemo(() => {
    return Array.from({ length: 10000 }, (_, i) => ({
      id: i + 1,
      name: `测试用户 ${i + 1}`,
      email: `user${i + 1}@virtual-list.com`,
      status: i % 3 === 0 ? 'active' : i % 3 === 1 ? 'pending' : 'inactive',
    }));
  }, []);

  const getStatusBadge = (status: string) => {
    const styles = {
      active: 'bg-green-100 text-green-800',
      pending: 'bg-yellow-100 text-yellow-800',
      inactive: 'bg-gray-100 text-gray-800',
    };
    const labels = { active: '活跃', pending: '待处理', inactive: '离线' };
    return (
      <span className={`text-xs px-2 py-1 rounded-full ${styles[status as keyof typeof styles]}`}>
        {labels[status as keyof typeof labels]}
      </span>
    );
  };

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800 mb-2">🚀 虚拟列表 (Virtual List) 性能测试</h2>
        <p className="text-gray-500">
          当前列表包含 <span className="font-semibold text-blue-600">{mockData.length.toLocaleString()}</span> 条数据。
          请尝试快速滚动，体验丝滑的性能！
        </p>
      </div>
      
      <VirtualList
        data={mockData}
        itemHeight={64}
        containerHeight={500}
        renderItem={(item) => (
          <div className="flex items-center gap-4 w-full">
            <div className="w-10 h-10 rounded-full bg-linear-to-br from-blue-400 to-purple-500 flex items-center justify-center text-white font-bold text-sm">
              {item.name.charAt(item.name.length - 1)}
            </div>
            <div className="flex-1">
              <div className="font-medium text-gray-900">{item.name}</div>
              <div className="text-sm text-gray-500">{item.email}</div>
            </div>
            {getStatusBadge(item.status)}
            <span className="text-xs text-gray-400 font-mono">ID: {item.id}</span>
          </div>
        )}
      />
      
      {/* 验证指南 */}
      <div className="mt-6 p-4 bg-green-50 border border-green-200 rounded-lg">
        <h3 className="text-green-800 font-bold mb-2">✅ 如何验证虚拟列表是否成功？</h3>
        <ul className="text-green-700 text-sm space-y-1 list-disc list-inside">
          <li><strong>检查 DOM 节点：</strong> 按 <code className="bg-green-100 px-1 rounded">F12</code> 打开开发者工具，切换到 Elements 面板。无论你怎么滚动，列表区域的 DOM 节点数量应该始终保持在 20-30 个左右，而不是 10,000 个。</li>
          <li><strong>检查滚动流畅度：</strong> 快速拖动滚动条，页面不应该出现明显的卡顿或掉帧。</li>
          <li><strong>检查内存占用：</strong> 在 Performance 或 Memory 面板中，内存占用应该保持在一个较低且稳定的水平。</li>
        </ul>
      </div>
    </div>
  );
}
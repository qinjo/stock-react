import type { ReactNode } from "react";

type PanelProps = {
  /** 面板标题（左侧，与右侧 meta 同一行） */
  title?: ReactNode;
  /** 标题旁的灰色补充信息（数据截至、样本量等） */
  meta?: ReactNode;
  /** 标题栏右侧的操作区（按钮、徽章等） */
  actions?: ReactNode;
  children: ReactNode;
  /** 覆盖外层容器样式（如需要 flex 拉伸） */
  className?: string;
  /** 覆盖内容区样式（默认 p-4） */
  bodyClassName?: string;
};

/**
 * 统一的面板容器：白底卡片 + 细边框 + 轻阴影 + 标题栏。
 *
 * 布局参考 Vibe-Research 的浅色工作台：页面是灰底，信息按面板切块，
 * 每块有固定的标题栏（标题 / 补充信息 / 操作），内容区自己决定留白。
 * 只做视觉容器，不承担任何数据逻辑。
 */
export function Panel({
  title,
  meta,
  actions,
  children,
  className = "",
  bodyClassName = "p-4",
}: PanelProps) {
  const hasHeader = Boolean(title || meta || actions);

  return (
    // 刻意不加 overflow-hidden：搜索补全列表等浮层是绝对定位、会超出面板边界，
    // 一刀切裁剪会让下拉“消失”。需要裁剪的图表类面板自己在 className 里加。
    <section
      className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}
    >
      {hasHeader && (
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-slate-100 px-4 py-2.5">
          <div className="flex flex-wrap items-baseline gap-2">
            {title && <h2 className="text-sm font-semibold text-slate-800">{title}</h2>}
            {meta && <span className="text-xs text-slate-400">{meta}</span>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

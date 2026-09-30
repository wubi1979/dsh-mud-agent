/**
 * dsh-mud-webui — MUD 玩家 logo（定制：充满画布的游戏手柄剪影）。
 *
 * 替换 Fluent「games」图标（24 画布自带内边距，实图约 20×15，视觉小一圈）。
 * 本图标手写 SVG，几何充满 24×17.66 视口 —— 与原生 FishLogo 同足印：
 * size=24 时盒子 24×17.66，塞满不留白。
 *
 * 设计（MUD 终端游戏语义）：
 *   - 主体：圆角胶囊手柄轮廓（描边风格，对齐 dsw 图标语言）；
 *   - 左：十字方向键；右：两枚圆钮（A/B）；
 *   - 全部用 currentColor 描边 + 局部填充，亮暗主题自动跟随。
 *
 * 几何：视口 24×17.66。手柄主体圆角矩形 x=0.8 y=1.4 w=22.4 h=14.86
 * rx=7（上下充满），十字键中心 (6.4, 8.83)，双钮中心 (17.2, 6.2)/(17.2, 11.5)。
 *
 * @module @deepseek-ai/dsh-mud-webui/client/MudLogo
 */

/** 手写手柄图标的视口（对齐原生 FishLogo 的 23.16:17.04 ≈ 24:17.66 比例）。 */
const VIEWBOX = { width: 24, height: 17.66 } as const

/** MudLogo 组件 props。 */
export interface MudLogoProps {
  /** 盒子宽度 px（高度 = 宽度 × 17.66/24）。 */
  size?: number
  /** 附加布局类。 */
  className?: string | undefined
}

/**
 * 渲染 MUD 玩家 logo（充满画布的手柄剪影）。
 * @param props.size - 盒子宽度（缺省 24；高度 17.66，原生 logo 同足印）。
 * @param props.className - 布局类（aria-hidden，配文字读屏）。
 * @returns logo svg。
 */
export function MudLogo({ size = 24, className }: MudLogoProps) {
  return (
    <svg
      width={size}
      height={size * (VIEWBOX.height / VIEWBOX.width)}
      viewBox={`0 0 ${VIEWBOX.width} ${VIEWBOX.height}`}
      fill="none"
      aria-hidden="true"
      className={className}
    >
      {/* 手柄主体：圆角胶囊，上下顶满视口（y 1.0 → 16.66，rx 7.83） */}
      <rect x="1.2" y="1.0" width="21.6" height="15.66" rx="7.83" stroke="currentColor" strokeWidth="1.5" />
      {/* 左侧十字方向键：中心 (6.8, 8.83)，臂长 2.1、臂宽 1.7、线端圆头 */}
      <path
        d="M6.8 5.6 v6.46 M3.55 8.83 h6.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      {/* 右侧双钮（A/B）：实心圆 r 1.55，垂直排布 */}
      <circle cx="16.9" cy="6.15" r="1.55" fill="currentColor" />
      <circle cx="16.9" cy="11.51" r="1.55" fill="currentColor" />
    </svg>
  )
}

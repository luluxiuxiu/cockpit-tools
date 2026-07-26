import { CSSProperties } from 'react';
import antigravityIcon from '../../assets/icons/antigravity-app.png';

type AntigravityCliIconProps = {
  className?: string;
  style?: CSSProperties;
};

/** Antigravity CLI（agy）图标：复用桌面图标并叠加 CLI 角标 */
export function AntigravityCliIcon({ className = 'nav-item-icon', style }: AntigravityCliIconProps) {
  const size =
    typeof style?.width === 'number'
      ? style.width
      : typeof style?.height === 'number'
        ? style.height
        : 20;
  const badgeSize = Math.max(8, Math.round(Number(size) * 0.42));

  return (
    <span
      className={className}
      style={{
        position: 'relative',
        display: 'inline-flex',
        width: size,
        height: size,
        ...style,
      }}
      aria-hidden="true"
    >
      <img
        src={antigravityIcon}
        alt=""
        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
      />
      <span
        style={{
          position: 'absolute',
          right: -1,
          bottom: -1,
          minWidth: badgeSize,
          height: badgeSize,
          padding: '0 2px',
          borderRadius: 3,
          background: 'rgba(45, 55, 72, 0.92)',
          color: '#f7fafc',
          fontSize: Math.max(7, Math.round(badgeSize * 0.72)),
          fontWeight: 700,
          lineHeight: `${badgeSize}px`,
          textAlign: 'center',
          letterSpacing: '-0.02em',
          boxShadow: '0 0 0 1px rgba(255,255,255,0.35)',
        }}
      >
        CLI
      </span>
    </span>
  );
}

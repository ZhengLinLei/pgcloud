import type { NodeType } from '../../../shared/types';

type P = { size?: number; className?: string };

const svg = (size: number, children: React.ReactNode, className?: string) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    {children}
  </svg>
);

/** Database cylinder */
export const PgIcon = ({ size = 18, className }: P) =>
  svg(
    size,
    <>
      <ellipse cx="12" cy="5.5" rx="7" ry="2.8" />
      <path d="M5 5.5v13c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-13" />
      <path d="M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8" />
    </>,
    className,
  );

/** Load balancer: one input split to three */
export const PoolIcon = ({ size = 18, className }: P) =>
  svg(
    size,
    <>
      <circle cx="12" cy="4.5" r="2.2" />
      <circle cx="5" cy="19" r="2.2" />
      <circle cx="12" cy="19" r="2.2" />
      <circle cx="19" cy="19" r="2.2" />
      <path d="M12 6.7v10M12 11l-6 6M12 11l6 6" />
    </>,
    className,
  );

/** Connection pooler: many lines merged */
export const BouncerIcon = ({ size = 18, className }: P) =>
  svg(
    size,
    <>
      <path d="M3 5h5l4 7 4-7h5" />
      <path d="M3 19h5l4-7 4 7h5" />
      <path d="M3 12h18" />
    </>,
    className,
  );

export const TypeIcon = ({ type, size }: { type: NodeType; size?: number }) =>
  type === 'postgres' ? <PgIcon size={size} /> : type === 'pgpool' ? <PoolIcon size={size} /> : <BouncerIcon size={size} />;

export const TYPE_LABEL: Record<NodeType, string> = {
  postgres: 'PostgreSQL',
  pgpool: 'Pgpool-II',
  pgbouncer: 'PgBouncer',
};

export const TYPE_COLOR: Record<NodeType, string> = {
  postgres: 'var(--pg)',
  pgpool: 'var(--pool)',
  pgbouncer: 'var(--bouncer)',
};

/** PgCloud elephant (docs/img/pgcloud_small_logo.png) used as a CSS mask, so it follows the text colour in both themes. */
export const Logo = ({ size = 22 }: P) => (
  <span className="brand-logo" role="img" aria-label="PgCloud" style={{ width: size * 1.15, height: size }} />
);

export const SunIcon = ({ size = 16 }: P) =>
  svg(
    size,
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>,
  );
export const MoonIcon = ({ size = 16 }: P) => svg(size, <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />);
export const LogoutIcon = ({ size = 16 }: P) =>
  svg(size, <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />);
export const PlayIcon = ({ size = 14 }: P) => svg(size, <path d="M6 4l14 8-14 8z" />);
export const StopIcon = ({ size = 14 }: P) => svg(size, <rect x="5" y="5" width="14" height="14" rx="2" />);
export const RestartIcon = ({ size = 14 }: P) =>
  svg(size, <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" />);
export const RocketIcon = ({ size = 14 }: P) =>
  svg(
    size,
    <>
      <path d="M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.1 2.1 0 0 0-2.9-.1Z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2Z" />
      <path d="M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5" />
    </>,
  );
export const TrashIcon = ({ size = 14 }: P) =>
  svg(size, <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />);
export const LinkIcon = ({ size = 14 }: P) =>
  svg(size, <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />);
export const FitIcon = ({ size = 14 }: P) =>
  svg(size, <path d="M3 9V5a2 2 0 0 1 2-2h4M15 3h4a2 2 0 0 1 2 2v4M21 15v4a2 2 0 0 1-2 2h-4M9 21H5a2 2 0 0 1-2-2v-4" />);
export const TerminalIcon = ({ size = 14 }: P) => svg(size, <path d="M4 17l6-6-6-6M12 19h8" />);
export const FileIcon = ({ size = 14 }: P) =>
  svg(size, <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5" />);
export const PlugIcon = ({ size = 14 }: P) =>
  svg(size, <path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4" />);
export const EyeIcon = ({ size = 14 }: P) =>
  svg(
    size,
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>,
  );
export const UploadIcon = ({ size = 14 }: P) => svg(size, <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />);
export const CloseIcon = ({ size = 14 }: P) => svg(size, <path d="M18 6 6 18M6 6l12 12" />);

// Shown only in the demo build (npm run build:demo).
export const DEMO = import.meta.env.MODE === 'demo';

export function DemoWatermark() {
  return (
    <>
      <style>{'.toasts { bottom: 58px; }'}</style>
      <div className="demo-watermark" aria-hidden="true">
        {Array.from({ length: 24 }, (_, i) => (
          <span key={i}>DEMO</span>
        ))}
      </div>
      <div className="demo-banner" role="note">
        <b>DEMO</b> Illustrative only: simulated data from a recorded test cluster, no servers behind this page.{' '}
        <a href="https://github.com/ZhengLinLei/pgcloud/tree/master/tools/pgcloud-launcher" target="_blank" rel="noreferrer">
          Get the launcher
        </a>
      </div>
    </>
  );
}

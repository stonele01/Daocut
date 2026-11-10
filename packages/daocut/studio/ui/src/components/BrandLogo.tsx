import daotianMark from '../../../../../../assets/brand/daotian-mark.svg?url';

/** The original Daotian company colors, shared by Studio and the desktop chat. */
export function BrandLogo({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <img
      src={daotianMark}
      alt="Daocut"
      width={size}
      height={size}
      draggable={false}
      style={{ width: size, height: size }}
      className={`block shrink-0 object-contain ${className ?? ''}`.trim()}
    />
  );
}

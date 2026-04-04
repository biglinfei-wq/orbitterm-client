import orbitLogo from '../assets/orbit-logo.png';

interface BrandLogoProps {
  className?: string;
  alt?: string;
}

export function BrandLogo({
  className = 'h-10 w-10 rounded-xl border border-white/30',
  alt = 'OrbitTerm logo'
}: BrandLogoProps): JSX.Element {
  return (
    <img
      alt={alt}
      className={className}
      draggable={false}
      src={orbitLogo}
    />
  );
}

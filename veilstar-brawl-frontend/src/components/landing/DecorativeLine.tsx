interface DecorativeLineProps {
  className?: string;
  variant?: 'left-red-right-gold' | 'left-gold-right-red';
}

export default function DecorativeLine({
  className = '',
  variant = 'left-red-right-gold',
}: DecorativeLineProps) {
  return (
    <div className={`relative w-full ${className}`}>
      <div
        className="absolute left-0 right-0 h-px"
        style={{
          background: 'linear-gradient(270deg, #F0B71F 0%, #E03609 100%)',
        }}
      />

      {variant === 'left-red-right-gold' ? (
        <>
          {/* Left icon - red/orange */}
          <svg
            className="absolute left-10 -top-[30px]"
            width="61"
            height="61"
            viewBox="0 0 61 61"
            fill="none"
          >
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M58.6783 18.8282C60.2111 22.5286 61 26.4947 61 30.5H30.5L30.5 0C34.5053 0 38.4714 0.788905 42.1718 2.32167C45.8723 3.85444 49.2346 6.10106 52.0668 8.93324C54.8989 11.7654 57.1456 15.1277 58.6783 18.8282ZM30.5 30.5L0 30.5C-3.50156e-07 34.5053 0.788905 38.4714 2.32167 42.1718C3.85444 45.8723 6.10105 49.2346 8.93324 52.0668C11.7654 54.8989 15.1277 57.1456 18.8282 58.6783C22.5286 60.2111 26.4947 61 30.5 61L30.5 30.5Z"
              fill="#E03609"
            />
          </svg>

          {/* Right icon - gold/yellow */}
          <svg
            className="absolute right-10 -top-[30px]"
            width="61"
            height="61"
            viewBox="0 0 61 61"
            fill="none"
          >
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M42.1718 58.6783C38.4714 60.2111 34.5053 61 30.5 61L30.5 30.5L61 30.5C61 34.5053 60.2111 38.4714 58.6783 42.1718C57.1456 45.8723 54.8989 49.2346 52.0668 52.0668C49.2346 54.8989 45.8723 57.1456 42.1718 58.6783ZM30.5 30.5L30.5 -1.3332e-06C26.4947 -1.85843e-06 22.5286 0.788903 18.8282 2.32167C15.1277 3.85444 11.7654 6.10105 8.93325 8.93324C6.10106 11.7654 3.85445 15.1277 2.32168 18.8282C0.788909 22.5286 2.65658e-06 26.4947 2.4815e-06 30.5L30.5 30.5Z"
              fill="#F0B71F"
            />
          </svg>
        </>
      ) : (
        <>
          {/* Left icon - gold/yellow */}
          <svg
            className="absolute left-10 -top-[30px]"
            width="61"
            height="61"
            viewBox="0 0 61 61"
            fill="none"
          >
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M2.32168 42.1718C0.788912 38.4714 6.13094e-06 34.5053 6.48109e-06 30.5L30.5 30.5L30.5 61C26.4947 61 22.5286 60.2111 18.8282 58.6783C15.1277 57.1456 11.7654 54.8989 8.93325 52.0668C6.10106 49.2346 3.85445 45.8723 2.32168 42.1718ZM30.5 30.5L61 30.5C61 26.4947 60.2111 22.5286 58.6783 18.8282C57.1456 15.1277 54.8989 11.7654 52.0668 8.93325C49.2346 6.10106 45.8723 3.85445 42.1719 2.32168C38.4714 0.788908 34.5053 1.49846e-06 30.5 1.1483e-06L30.5 30.5Z"
              fill="#F0B71F"
            />
          </svg>

          {/* Right icon - red/orange */}
          <svg
            className="absolute right-10 -top-[30px]"
            width="61"
            height="61"
            viewBox="0 0 61 61"
            fill="none"
          >
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M18.8282 2.32168C22.5286 0.788913 26.4947 7.28906e-06 30.5 7.81429e-06L30.5 30.5L3.99959e-06 30.5C4.52483e-06 26.4947 0.78891 22.5286 2.32168 18.8282C3.85445 15.1277 6.10106 11.7654 8.93325 8.93325C11.7654 6.10106 15.1277 3.85445 18.8282 2.32168ZM30.5 30.5L30.5 61C34.5053 61 38.4714 60.2111 42.1718 58.6783C45.8723 57.1456 49.2346 54.899 52.0668 52.0668C54.8989 49.2346 57.1456 45.8723 58.6783 42.1719C60.2111 38.4714 61 34.5053 61 30.5L30.5 30.5Z"
              fill="#E03609"
            />
          </svg>
        </>
      )}
    </div>
  );
}

/**
 * Clash Shards Icon Component
 * Custom SVG icon representing Clash Shards currency
 */

interface ClashShardsIconProps {
    className?: string;
}

export function ClashShardsIcon({ className }: ClashShardsIconProps) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={className}
        >
            <path
                d="M12 2L15.5 8L22 9L17 14L18 21L12 17.5L6 21L7 14L2 9L8.5 8L12 2Z"
                fill="currentColor"
                opacity="0.2"
            />
            <path
                d="M12 2L15.5 8L22 9L17 14L18 21L12 17.5L6 21L7 14L2 9L8.5 8L12 2Z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <path
                d="M12 6L14 10L18 10.5L15 13.5L15.5 17.5L12 15L8.5 17.5L9 13.5L6 10.5L10 10L12 6Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity="0.6"
            />
        </svg>
    );
}
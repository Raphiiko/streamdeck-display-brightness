import { h } from 'preact';

const creatorLinks = [
  {
    label: 'GitHub',
    url: 'https://github.com/Raphiiko/streamdeck-display-brightness',
  },
  {
    label: 'Website',
    url: 'https://raphii.co',
  },
];

interface CreatorHeaderProps {
  onOpenUrl?(url: string): void;
}

export function CreatorHeader({ onOpenUrl }: CreatorHeaderProps) {
  const handleLinkClick = (url: string, event: MouseEvent) => {
    event.preventDefault();
    onOpenUrl?.(url);
  };

  return h(
    'div',
    { className: 'creator-header' },
    h('span', { className: 'creator-name' }, 'By Raphiiko'),
    h(
      'div',
      { className: 'creator-links' },
      creatorLinks.map((link) =>
        h(
          'a',
          {
            key: link.url,
            href: '#',
            'data-url': link.url,
            onClick: (e: MouseEvent) => handleLinkClick(link.url, e),
          },
          link.label
        )
      )
    )
  );
}

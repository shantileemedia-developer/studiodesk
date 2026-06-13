import React, { useEffect, useRef } from 'react';
import './ContextMenu.css';

export interface ContextMenuItem {
  label?: string;
  onClick?: () => void;
  separator?: true;
  disabled?: boolean;
  danger?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // Small delay so the same right-click that opened it doesn't close it
    // Use capture phase so stopPropagation in child elements can't block dismiss
    const t = setTimeout(() => {
      document.addEventListener('mousedown', down, true);
      document.addEventListener('keydown', key);
    }, 50);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', down, true);
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);

  // Keep menu on screen
  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - items.length * 30 - 8),
    zIndex: 9999,
  };

  return (
    <div ref={menuRef} className="context-menu" style={style}>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="ctx-separator" />
        ) : (
          <div
            key={i}
            className={`ctx-item ${item.disabled ? 'disabled' : ''} ${item.danger ? 'danger' : ''}`}
            onMouseDown={e => {
              e.preventDefault();
              e.stopPropagation();
              if (!item.disabled) { item.onClick?.(); onClose(); }
            }}
          >
            {item.label}
          </div>
        )
      )}
    </div>
  );
};

export default ContextMenu;

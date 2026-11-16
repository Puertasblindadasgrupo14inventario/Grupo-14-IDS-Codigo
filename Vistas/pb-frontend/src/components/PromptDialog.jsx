import { useEffect, useRef, useState } from 'react';
import Dialogo from './Dialogo';

/** Reemplaza pbPrompt de api.js. F-25c: con el diálogo del sistema. */
export default function PromptDialog({ message, title, placeholder, onAccept, onCancel }) {
  const [value, setValue] = useState('');
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <Dialogo
      id="pb-dialog-overlay"
      tamano="sm"
      titulo={title || 'Ingrese información'}
      acciones={<>
        <button id="pb-dlg-cancel" className="btn btn-secondary" onClick={onCancel}>Cancelar</button>
        <button id="pb-dlg-ok" className="btn btn-primary" onClick={() => onAccept(value)}>Aceptar</button>
      </>}
    >
      <div className="dialogo-mensaje" style={{ marginBottom: 12 }}>{message}</div>
      <input
        id="pb-dlg-input"
        ref={inputRef}
        className="form-control"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') onAccept(value); }}
        placeholder={placeholder || ''}
      />
    </Dialogo>
  );
}

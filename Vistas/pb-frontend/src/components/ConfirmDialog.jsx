import Dialogo from './Dialogo';

/** Reemplaza pbConfirm de api.js. F-25c: con el diálogo del sistema. */
export default function ConfirmDialog({ message, title, onConfirm, onCancel }) {
  return (
    <Dialogo
      id="pb-dialog-overlay"
      tamano="sm"
      titulo={title || 'Confirmar acción'}
      acciones={<>
        <button id="pb-dlg-cancel" className="btn btn-secondary" onClick={onCancel}>Cancelar</button>
        <button id="pb-dlg-ok" className="btn btn-primary" onClick={onConfirm}>Confirmar</button>
      </>}
    >
      <div className="dialogo-mensaje">{message}</div>
    </Dialogo>
  );
}

import { useId } from 'react';

/**
 * F-25c (lineamientos de composición, sección 7): diálogo modal del sistema, con cabecera, cuerpo y pie con las
 * acciones. Usa las clases .modal de global.css y queda sobre cualquier otro modal, salvo la firma de gerencia,
 * que va encima para que una acción con firma lanzada desde un Dialogo abierto no quede tapada.
 * Props: titulo, subtitulo, tamano ('sm' 420 px, 'md' 480 px, 'lg' 720 px; sin él, 560 px),
 * acciones (botones del pie), id (del fondo, para las pruebas) y children (el cuerpo).
 */
export default function Dialogo({ titulo, subtitulo, tamano, acciones, id, children }) {
  const idTitulo = useId();
  return (
    <div id={id} className="modal-backdrop show dialogo-capa">
      <section className={`modal${tamano ? ` modal-${tamano}` : ''}`} role="dialog" aria-modal="true" aria-labelledby={idTitulo}>
        <header className="modal-header">
          <div>
            <h2 id={idTitulo} className="modal-title">{titulo}</h2>
            {subtitulo && <p className="modal-subtitle">{subtitulo}</p>}
          </div>
        </header>
        <div className="modal-body">{children}</div>
        {acciones && <footer className="modal-footer">{acciones}</footer>}
      </section>
    </div>
  );
}

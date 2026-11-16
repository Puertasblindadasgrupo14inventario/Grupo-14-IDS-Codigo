import { useAuth } from '../hooks/useAuth';
import { ocultaMontos } from '../utils/user';

/**
 * F-35 (D87): aviso de que los montos de la pantalla son netos (sin IVA; el IVA lo aplica Finanzas).
 * Solo para quien ve montos (D50): a jop no se le envían.
 */
export default function NotaMontosNetos({ style }) {
  const { user } = useAuth();
  if (ocultaMontos(user)) return null;
  return (
    <div className="nota-montos-netos" style={{ fontSize: 12, color: 'var(--gray)', ...style }}>
      Montos en CLP netos, sin IVA.
    </div>
  );
}

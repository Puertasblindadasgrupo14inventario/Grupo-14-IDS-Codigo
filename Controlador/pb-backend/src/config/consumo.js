/**
 * F-33: aviso de consumo excedido en una OT (reunion con el cliente del 13/10).
 *
 * Al guardar el consumo, si el real de una linea supera lo estimado por la receta
 * (que ya incluye la merma) en mas de esta fraccion, el backend responde 409
 * CONSUMO_EXCEDIDO con el detalle y no mueve stock hasta que se confirme.
 * No bloquea: con `confirmar_exceso: true` se guarda y queda en la auditoria.
 *
 * Fraccion, igual que la merma: 0.10 = 10 % (estimado 2 → avisa sobre 2,2).
 */
const UMBRAL_EXCESO_CONSUMO = 0.10;

module.exports = { UMBRAL_EXCESO_CONSUMO };

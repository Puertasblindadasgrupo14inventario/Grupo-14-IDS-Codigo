const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/integracionController');
const { authMiddleware, soloGerencia } = require('../middleware/auth');
const { requiereFirma } = require('../middleware/firma');

// index.js no pone la barrera del módulo aquí (B-45): /movimientos y /stock los usan los
// usuarios de otros módulos. Las reglas de CU-108 son de Gerencia (D95: sin administrador).
router.use(authMiddleware);

router.get('/reglas', soloGerencia, ctrl.listarReglas);      // CU-108
router.post('/reglas', soloGerencia, requiereFirma('reglas_integracion'), ctrl.crearRegla);       // CU-108 Exc 2
router.put('/reglas', soloGerencia, requiereFirma('reglas_integracion'), ctrl.actualizarRegla);   // CU-108 Exc 3
router.delete('/reglas', soloGerencia, requiereFirma('reglas_integracion'), ctrl.eliminarRegla);  // CU-108: corregir una regla creada por error

// CU-107: sin filtro de rol aquí; lo decide la regla de CU-108 (Exc 1)
router.post('/movimientos', ctrl.registrarMovimiento);

// CU-106: consulta de stock; basta la sesión (token del login común), sin regla de CU-108
router.get('/stock', ctrl.consultarStock);

module.exports = router;

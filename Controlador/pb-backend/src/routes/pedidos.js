const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/pedidosController');
const { authMiddleware, soloOperativo } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/',                    ctrl.listar);
router.get('/:id/checklist',      ctrl.checklist);
router.post('/:id/reservar',      soloOperativo, ctrl.reservar);   // D62 (B-45)
// CU-110
router.post('/:id/discrepancia',  soloOperativo, ctrl.reportarDiscrepancia);

module.exports = router;

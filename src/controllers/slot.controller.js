const asyncHandler = require('../utils/asyncHandler');
const slotService = require('../services/slot.service');
const { serializeSlot } = require('../utils/serialize');

const list = asyncHandler(async (req, res) => {
  const slots = await slotService.listSlots({ status: req.query.status, block: req.query.block });
  res.json({ slots: slots.map(serializeSlot) });
});

const occupancy = asyncHandler(async (req, res) => {
  res.json(await slotService.occupancySummary());
});

module.exports = { list, occupancy };

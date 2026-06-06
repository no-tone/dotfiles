local cmp = require("cmp")

-- Command-line completion for :
cmp.setup.cmdline(":", {
  mapping = cmp.mapping.preset.cmdline(),
  sources = {
    { name = "cmdline" }, -- provides command completions
  },
})

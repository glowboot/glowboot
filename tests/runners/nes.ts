/**
 * NES test-ROM accuracy runner.
 *
 * Auto-fetches christopherpow's `nes-test-roms` collection (the canonical
 * aggregate: nestest, blargg's ppu/apu/cpu/dmc suites, the mapper and sprite
 * tests) into a gitignored cache, then runs the headless `src/nes/` engine
 * against it. Mirrors the GB and GBA runners next to this file
 * (GBA): fetch-on-first-run, SHA256-pin where known, self-scoring.
 *
 * Stage 1 — the 6502: `nestest.nes` runs deterministically from $C000 with no
 * PPU/APU needed, and ships with a Nintendulator golden trace. We diff our
 * per-instruction state (PC, opcode bytes, A/X/Y/P/SP, cumulative CPU cycles)
 * line-by-line against that log and report the first divergence. This is the
 * gold-standard 6502 validation.
 *
 * Usage:
 *   npm run test:roms nes             run every wired test
 *   npm run test:roms nes nestest     filter by substring
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseNesRom } from "../../src/nes/cartridge/rom.js";
import { type Bus, CPU } from "../../src/nes/cpu/cpu.js";
import { Nes } from "../../src/nes/nes.js";
import { type Region } from "../../src/nes/region/region.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CACHE = resolve(__dirname, "..", "roms", "nes");

const REPO = "christopherpow/nes-test-roms";
// nes-test-roms is effectively frozen; pin to a commit for reproducibility.
const COMMIT = "95d8f621ae55cee0d09b91519a8989ae0e64753b";
const BASE_URL = `https://raw.githubusercontent.com/${REPO}/${COMMIT}`;

// SHA256 of each fetched file, pinned alongside the commit so a tampered or
// truncated download is caught instead of silently mis-scoring a test.
const SHA256: Record<string, string> = {
  "other/nestest.nes": "f67d55fd6b3cf0bad1cc85f1df0d739c65b53e79cecb7fea8f77ec0eadab0004",
  "other/nestest.log": "442c4dd5539c7e88b3fd73c7b732a7eadbd22b47c2cd9e58397ef147f64f6f8f",
  "instr_test-v5/rom_singles/01-basics.nes": "4dd1cdd406bc3f747972e7da314ce8ca89321eb7a836c1ced569ee54ae44a384",
  "instr_test-v5/rom_singles/02-implied.nes": "1c4d4fa130cf6feebc072543a5cd3627ae71063b56b08642bf43e9a6c6f44996",
  "instr_test-v5/rom_singles/03-immediate.nes": "6f7ad8ff31c762c37deaee0f323df03eb94025cf1f3b0343ebe6fe567da0e943",
  "instr_test-v5/rom_singles/04-zero_page.nes": "7a8feada4bb4460250c8f05401e5d728878bbe71956756d0b11d488e57eb12fd",
  "instr_test-v5/rom_singles/05-zp_xy.nes": "767f422dc4e651e331456b207f7c6d60d19329fde0c0827e83591dbd91ae5e23",
  "instr_test-v5/rom_singles/06-absolute.nes": "98df36dc4fcc4f37d9eb0539c71283020776b1e5dc6a6ce58671739a8d6534af",
  "instr_test-v5/rom_singles/07-abs_xy.nes": "9ff58d77d8d384cc918fcd3ed877898c5e7330cd475ed2dafb11cbe80ff32eff",
  "instr_test-v5/rom_singles/08-ind_x.nes": "2ec6f5d4a8caee5d8295cebe563f203c26ea9bc05f1dbc967feb88f5dc4f261f",
  "instr_test-v5/rom_singles/09-ind_y.nes": "0fbc8b228d5daa83a4a083bf87ae3a61b5247ebdd91a6b91c8cf8c42784804ac",
  "instr_test-v5/rom_singles/10-branches.nes": "63ab768e88931db6f7dfcfafe43d5e29ebc3dcb80da8fc7fcda8c930f34aef54",
  "instr_test-v5/rom_singles/11-stack.nes": "c534191fe3ea4c8940944fda98dd58eb42710268d453f97e8e2c4ae7f15f9cdb",
  "instr_test-v5/rom_singles/12-jmp_jsr.nes": "f5b4652690fc04e6b573a2b3b54a29407ad0615d3c264e7cb618b6694b50de55",
  "instr_test-v5/rom_singles/13-rts.nes": "b711d25bc55585c252046a1304a0bc64c13cacce7c96a1bac5c8e91f9fc2597f",
  "instr_test-v5/rom_singles/14-rti.nes": "f084b00605be1840946b53935032581e68abe1bb24479942751cfe46ddfcb280",
  "instr_test-v5/rom_singles/15-brk.nes": "da7ae9a191c4483b540771e15b1f6f18df68f1d1ecd717b59ea8b1ee3596ec3e",
  "instr_test-v5/rom_singles/16-special.nes": "7d03410b61784e49920901e84b00a4f31a19078391f20005c6fac9036d2190f7",
  "sprite_hit_tests_2005.10.05/01.basics.nes": "51819e8e502bd88fe3b7244198a074dbeef2e848f66c587be04b04f1f0d4bb52",
  "sprite_hit_tests_2005.10.05/02.alignment.nes": "125bbb3ce1e67370f1f4559c2ad3221e52a3e98880b9789400292b5f3a8b39e6",
  "sprite_hit_tests_2005.10.05/03.corners.nes": "9dd57776bc6267fe6183c5521d67cbe3fccc6662ae545eb2c419949bf39644d3",
  "sprite_hit_tests_2005.10.05/04.flip.nes": "5f7142bddb51b7577f93fa22f9f668efebbeea00346d7255089e1863acb9d46a",
  "sprite_hit_tests_2005.10.05/05.left_clip.nes": "69b329658c17b953f149c2f0de77eb272089df22c815bd2fd3d6f43206791c13",
  "sprite_hit_tests_2005.10.05/06.right_edge.nes": "8e6653fcb869e06873e29e5e4423122ea72ba0bf38f3ba9e39f471420db759a4",
  "sprite_hit_tests_2005.10.05/07.screen_bottom.nes":
    "05849956f80267838c5b6556310266b794078a4300841cbb36339fd141905a0b",
  "sprite_hit_tests_2005.10.05/08.double_height.nes":
    "127fd966b6b32d6d88a53c5f59d7e938827783c9ad056091f119be1c4ab21c71",
  "sprite_hit_tests_2005.10.05/09.timing_basics.nes":
    "311698c717e50150edd0b5fd0016c41de686463205c20efb5630d6adb90859fd",
  "sprite_hit_tests_2005.10.05/10.timing_order.nes": "0f36bc07bfe51c416e3cc1a5231053572aa6b15aa60e6d2fd0568be49b6dc2e9",
  "sprite_hit_tests_2005.10.05/11.edge_timing.nes": "5a7c121f6e76617be88a0a7035c0e402293be5c685c95b97190a8d70835736ab",
  "branch_timing_tests/1.Branch_Basics.nes": "7b69e3044eaeb86317147a900d1f4a467b666f59d375ec1ba6658233f23786cd",
  "branch_timing_tests/2.Backward_Branch.nes": "f7966e9b86b04b4adb987439a442e926e9cfe6bb71436dd5dd56f41f9eb029a4",
  "branch_timing_tests/3.Forward_Branch.nes": "d0fbc6b1899bc948172c45f37a981eb0dade212d7e807cc56efedae93d6f9c9b",
  "cpu_timing_test6/cpu_timing_test.nes": "6ab4fe8af23b12ca0dfccfc030de3d4069bf2498e3ef20ddcf1ca75555065b85",
  "blargg_nes_cpu_test5/cpu.nes": "782b97d45ade98f642893341277bf161d6ff0f973fd0de0de3753d844e931940",
  "blargg_nes_cpu_test5/official.nes": "5b412b3940abe3f9ed562b86b93cf660688bee95eba927c4dacd53c9da89fe9a",
  "dmc_tests/buffer_retained.nes": "32aaccfa2fda811d1127feeaf4dcf36cf1803cca866800c71815dfb86254daae",
  "dmc_tests/latency.nes": "346c182ce408280a4fb14513f18ae519b135136a250ed3738abc295a6a1b2208",
  "dmc_tests/status.nes": "ef18582e0625dfe522bdf2f8b0b16cd221c630940fbc97c52c8cf23832ce92bd",
  "dmc_tests/status_irq.nes": "81013c38721e966f037969aae7c66a5f904fc706f96437910b93f7262cb77a70",
  "exram/mmc5exram.nes": "8297cfb986a8393ffbd47549b120d16fac53c1bf96da4f26ceb9ff30ecca50d2",
  "dmc_dma_during_read4/dma_2007_read.nes": "a2e0fa3f6f155cbe0b8c9517b2f6a57f1fd68f13711c11d6d2fe5676c522d7b2",
  "dmc_dma_during_read4/dma_2007_write.nes": "54c75d491c685fb4cfff281bcf3e199a41e95f6c523e2b0607d67ba039f19f84",
  "dmc_dma_during_read4/dma_4016_read.nes": "c6af72e11c197b449129921a9992db2351d9121bb593b3d0ab71895b646b0ebe",
  "dmc_dma_during_read4/double_2007_read.nes": "779e6e7db863a7405a3dda8723b8517a23d271e78ce4802970fb0a7d3039ce6b",
  "dmc_dma_during_read4/read_write_2007.nes": "bc5281ca3f12a6d0ac9fe1a5e727ecc3cac5fc6a47f45ac130d644f0dbd522cf",
  "read_joy3/count_errors.nes": "3cfa68394b8202d5fb84b8b0bea9994de70ed7b12ce2f70117edb1e4332cf2ea",
  "read_joy3/thorough_test.nes": "e59de3d542043acd1dbca1e499ea9987b581f8be168ba88603e6e90826f87cf9",
  "mmc3_test_2/rom_singles/1-clocking.nes": "b06d8a97f0ca672be92c841d6af7d1e650696e86e9cc0cf6eeb90d67a6ab499b",
  "mmc3_test_2/rom_singles/5-MMC3.nes": "e0824123d60b83868dac1189b28250f8e10376a01be468a5a74aa59937cb32ca",
  // Mapper test ROMs (visual result screens, self-scored by framebuffer hash).
  "mmc3_irq_tests/1.Clocking.nes": "699d0644bd2b6ff4c9ba598c9609f4a3da536594b6363585b2caf82cf337ac88",
  "mmc3_irq_tests/2.Details.nes": "0af95238b69806c072c28aed0fa8ad812157dfee928a6c9cea8d5420268baade",
  "mmc3_irq_tests/3.A12_clocking.nes": "3b936e1079f12bdc5e55aa82def017ddc76fd79e3879ff0478d41ca718302e7c",
  "mmc3_irq_tests/4.Scanline_timing.nes": "3369e8f73a96ec97918c6c9440804a369a19256c57df91e62881555f21528894",
  "mmc3_irq_tests/5.MMC3_rev_A.nes": "6b662c2d08ee4094d89b6d1ddde330e47f81929fb642dc217b6e4c33f8926944",
  "mmc3_irq_tests/6.MMC3_rev_B.nes": "d8a2af42cdafe8046b36109e6f6ff71ca0d7f5d62c7d5953e0aa1d1828a86088",
  "mmc5test_v2/mmc5test.nes": "f18f60a27cae9c00b51782caa3b77cf96a11e1c45e4323a9815474728e5b2980",
  "MMC1_A12/mmc1_a12.nes": "42f622a8f3c5d352cdffdad7e2fdbc982c9ef97cf83e98ac71230df86cc85fc1",
  "cpu_dummy_reads/cpu_dummy_reads.nes": "db4f91b80c5fbc123e7dcb420fb7fea9b8a18613edf4de7f3d1e3ed95e3117c9",
  // Additional blargg $6000-protocol suites (full-system, runBlarggSystem).
  "instr_timing/instr_timing.nes": "3d1bca14266f1e25b75a34ddd29c9df1ce9c6d990c8663a218f72e7861660fb0",
  "instr_misc/instr_misc.nes": "b6762e20a285216304dfd2b5e1f192459354b23a5e48b2f5f9fb7cb0dac51243",
  "cpu_dummy_writes/cpu_dummy_writes_oam.nes": "7c1d71a38b2e873d0874add8b823ff39b99151bb29f50096d8021787020c566c",
  "cpu_dummy_writes/cpu_dummy_writes_ppumem.nes": "f59ac329f4872277ccbeff9dd595b901d861af8d53e8a43dcca93bb86752a6b3",
  "oam_read/oam_read.nes": "f298973dabeb61ca35007445f7a615f77e87703c958c870986af83b1aabde926",
  "oam_stress/oam_stress.nes": "95882d72a7acabe928fd277e3b3e0372f21ef3d41e36d7d8fb17fc017a356f70",
  "ppu_vbl_nmi/rom_singles/01-vbl_basics.nes": "06aea5af4edab4e3141c939cd5ac9936f8758203b25dcaf84ae1a09db49e024a",
  "ppu_vbl_nmi/rom_singles/02-vbl_set_time.nes": "dd98856130078844e3aa4bd95a9be8ab501ea84c089f1d8ad49a1b20af4b3a80",
  "ppu_vbl_nmi/rom_singles/03-vbl_clear_time.nes": "787fdaa4dd6c5b6df5f4308fb6d55b57e2c2f69bd5ecdf8ad5c69735db4fcc72",
  "ppu_vbl_nmi/rom_singles/04-nmi_control.nes": "84722c75b896c47c8642f83220230fe14f0a31e55e26ecb83c400e6a26d91b32",
  "ppu_vbl_nmi/rom_singles/05-nmi_timing.nes": "72e515d689d7404ae5779b8c9c4c7b3563a755a94bd44864516f1b03df044482",
  "ppu_vbl_nmi/rom_singles/06-suppression.nes": "811dd5997bbf48c2e5687ab06845f17ea76b2be472786596c334137582cc72aa",
  "ppu_vbl_nmi/rom_singles/07-nmi_on_timing.nes": "1ed154363660b5775b112ae63ce9bb4e400ebde2afef4d0ac12fc433efda3702",
  "ppu_vbl_nmi/rom_singles/08-nmi_off_timing.nes": "1d2a4093091c8e58a7f99d6a3531bbc6346b52cfc59bcb17ca04c1f2376cf2fc",
  "ppu_vbl_nmi/rom_singles/09-even_odd_frames.nes": "1ac04283021ddd9294cc74ee709c55e20a350dc4815c15a8a93b3654837e858d",
  "ppu_vbl_nmi/rom_singles/10-even_odd_timing.nes": "7217d2d172ce11ad45c4da40c2f22201cf0eb758bc2cd8dd39d2cf0a7d4ca83e",
  "apu_test/rom_singles/1-len_ctr.nes": "aacf86c1d773badd11392e54506a43a06a3dd0b67a4c255909d1daf770a4a1e2",
  "apu_test/rom_singles/2-len_table.nes": "c002ff1483b4dfb36a6eb004d49739cd58a2dff16e0bac167d5a7c12235caeeb",
  "apu_test/rom_singles/3-irq_flag.nes": "dd888551665937391a2d691b1f96d1858316dbfce4951306146e9e396367f079",
  "apu_test/rom_singles/4-jitter.nes": "bff573d72d0f134fe307f0bb8b968b8d2ffdb85e8aadad9c152839068d6db32a",
  "apu_test/rom_singles/5-len_timing.nes": "4d88f8cc0b21303dc151af4d0f4169d79284634a73082d7ea1ae5cfafedd1e46",
  "apu_test/rom_singles/6-irq_flag_timing.nes": "fc1daff82dd1a49c7c1242392ffbf1c6f44fb70156868582117f2a844cc4dffd",
  // The full cpu_interrupts_v2 suite ($6000): CLI latency, NMI-hijacking BRK,
  // NMI hijacking IRQ vectoring, IRQ timing across sprite DMA, and the
  // taken-branch IRQ-poll delay.
  "cpu_interrupts_v2/rom_singles/1-cli_latency.nes": "e402d36118f77dcbbe8ddca90c15fc76a46bcb30b25cb028c383e4a621de5fc0",
  "cpu_interrupts_v2/rom_singles/2-nmi_and_brk.nes": "6e6bf6205930afcfebdc213c583df53986a688a8b36f8856b805ef4c1853e6eb",
  "cpu_interrupts_v2/rom_singles/3-nmi_and_irq.nes": "3008a9524d174a8aca562ff0361eba81da53e38cf1ebb5125322fe151f14d945",
  "cpu_interrupts_v2/rom_singles/4-irq_and_dma.nes": "6d7b4c1947ada64679af56cf0c227286b2408afe1747dfaa4dc7363d57ff87f6",
  "cpu_interrupts_v2/rom_singles/5-branch_delays_irq.nes":
    "f9e10b4a24d8f3cd3e51fb7457c72858aab96a6467fdbbd806d0661c2d32fdc7",
  "ppu_read_buffer/test_ppu_read_buffer.nes": "230a52fc557c098eba163801d1b6bbf9f57fe8c5ff79a3f968c804dedb1290ba",
  // Sprite-overflow flag (screen-only result, hashed framebuffer).
  "sprite_overflow_tests/1.Basics.nes": "1a6782f63ccb3a3dd1aa6a24272036c9c3aa232c2d1ff0b21e872741a3ee4fe2",
  "sprite_overflow_tests/2.Details.nes": "6405a7ff1042fe7a50d9bfe521e43460a3251799425bd3e1863b29b67e7cd587",
  "sprite_overflow_tests/3.Timing.nes": "2252ec8fc35932b408f409ef9b6863edf084aa871fc10ad180b0ac4c2468ef8c",
  "sprite_overflow_tests/4.Obscure.nes": "aebf2199344321465ae0d8dcd81f6c528c7f661f31f1814711365b4e573a8263",
  "sprite_overflow_tests/5.Emulator.nes": "cf994454219696de82794f0b84f2bd63458444d12a1171c85bba8697ab94acb4",
  // PAL APU length/IRQ timing (screen-only result, run in PAL region).
  "pal_apu_tests/01.len_ctr.nes": "5e4a07738703232dfefce6a26f12da304f333008c60224b27e7fbadf4a7cdc0c",
  "pal_apu_tests/02.len_table.nes": "ac5537885469a85e733df1a7a6a0a76a76f157f080c60d04f1128902a45423d4",
  "pal_apu_tests/03.irq_flag.nes": "e0c04111c61d0fc671990c5c3ac6cb7f57082ad687b5e11d380277c7d75e56d1",
  "pal_apu_tests/04.clock_jitter.nes": "dc85b14f7ece5e7bd4010b831f5b796debfdf338837c8a29a1d221de8c63776d",
  "pal_apu_tests/05.len_timing_mode0.nes": "04896f081373f5ab6ce83ce115c5fc0ff823acf831f1499d7d406f4a651e7cbc",
  "pal_apu_tests/06.len_timing_mode1.nes": "454b1b6339bd2ea27e3f4e8a8de7e2d95e3afc26940a88255e24a033d42d5a05",
  "pal_apu_tests/07.irq_flag_timing.nes": "c91aa1fc7bcb2638f3b07996270eb38c67e8b0fefa1a0db02a34b2e2ffd883c7",
  "pal_apu_tests/08.irq_timing.nes": "dee9e8fac623327b04e8160456362cc1fe4ca0b2c8e3f45eedcb6851ebb00aae",
  "pal_apu_tests/10.len_halt_timing.nes": "c41238ed0e7f4044c21fcd14c99b9e4516611adbee5c5f139d3bb95bebebcec9",
  "pal_apu_tests/11.len_reload_timing.nes": "1e94a9c0d829378f93b460c2c5f875418490401afd50c30cd05ea22113819909",
  // Older blargg VBlank/NMI timing suite (screen-only) — independent of the
  // ppu_vbl_nmi suite; corroborates the same cycle-timing from a second author.
  "vbl_nmi_timing/1.frame_basics.nes": "719bf4b4ea9022aad4216b159f59846ea57f98c8bddc5069b70286f5b810e998",
  "vbl_nmi_timing/2.vbl_timing.nes": "39231f002784b62e5d0ab67735855198b6b62c6c6ef06b0549333cd818879fb2",
  "vbl_nmi_timing/3.even_odd_frames.nes": "268d5e305ab73a29ff524906f92db7da1944763ea3de464e14a44c5b4199049e",
  "vbl_nmi_timing/4.vbl_clear_timing.nes": "8552a65de49b677cdf7fd419f5ac51f96766786e1e1442f6f9d62c87f4c15c2c",
  "vbl_nmi_timing/5.nmi_suppression.nes": "059c8df6a9b41a95e827608f1c0edb496b763e0c2b861f22614f5f228f1e10aa",
  "vbl_nmi_timing/6.nmi_disable.nes": "4573dcff3c57351b0e6ce76d86334586ba3d1cd6d4f9ec014887e94912f543cf",
  "vbl_nmi_timing/7.nmi_timing.nes": "26a2475828ef9ebd6178129f530a8aaa6f9f1ddd493616f1524d8323d6e56a4c",
  // Reset-button behaviour ($6000 protocol with a $81 reset request). 4017_timing
  // and 4017_written probe $4017's reset-rewrite semantics we don't model and
  // aren't gated.
  "apu_reset/4015_cleared.nes": "ef83bc2831f0ddb9e563ac5cbcfa21b129f092911ef42adabae7d47b3e990d95",
  "apu_reset/irq_flag_cleared.nes": "e2435b213bf21065b7c9c645359500c1c860a7395d12d051232ab14dad1b0bb5",
  "apu_reset/len_ctrs_enabled.nes": "e05546cbfaa1414d9193b0212084b324ea6b13130af5f171a34c9e574f5ac373",
  "apu_reset/works_immediately.nes": "c750113762ee375319b1bfbf65c457875dbb194649d7e7b3594fba38eb8eefa1",
  "cpu_reset/registers.nes": "a30f33fb6c9f56012fba38dc85ddc3dccc06bfc0b25fef7711b63f8207279715",
  "cpu_reset/ram_after_reset.nes": "f1802a5618aaaa0c4d592caa45b0b13c54082af93fc311bda0c27bceacbc7c7f",
  // blargg's 2005 PPU set — the probes not covered by our newer suites: palette
  // RAM mirroring, sprite-RAM access ($2003/$2004/$4014), and $2007 VRAM access.
  // (vbl_clear_time duplicates ppu_vbl_nmi/03; power_up_palette checks values
  // unique to blargg's console, so neither is gated.)
  "blargg_ppu_tests_2005.09.15b/palette_ram.nes": "11c1de16c67795b247169819a34b9d4dd46165478d6de19d7cd6e7311e906a80",
  "blargg_ppu_tests_2005.09.15b/sprite_ram.nes": "81275795ea64dfe22f05e35ef3316e6cf84eba40fc9538fc637a08bf263a3110",
  "blargg_ppu_tests_2005.09.15b/vram_access.nes": "a0cde2a3c98d9f62afcba62d4e8f4f4228574ff96ce96fbfdc777e1393c16ee6",
  // Previously-ungated failures, now gated honestly as known-bad ($6000 code).
  // 8-dmc_rates passes; 7-dmc_basics fails its #19 (the sample buffer we don't
  // model). cpu_exec_space (exec from APU/PPU registers), ppu_open_bus decay,
  // and apu_reset's $4017 reset-rewrite are real gaps we now track.
  "apu_test/rom_singles/7-dmc_basics.nes": "547324867ee0ba2aa11401001d8d1288530aa4e0ecaaac1667ce79980a388ec1",
  "apu_test/rom_singles/8-dmc_rates.nes": "5d9a79a505b37fa277cacc95a362f7e2a56e59ace7a698213d78432cc06a8867",
  "apu_reset/4017_timing.nes": "0e6072c6dcee98fb73dc7f3af2e48face78be300e8510515ed48dc75d15c1f13",
  "apu_reset/4017_written.nes": "022bd3b45a733179d9a0a9bf0311d09ca81419d7e7434e6f559e42650b39616b",
  "cpu_exec_space/test_cpu_exec_space_apu.nes": "9036b3d64b7f4e0ac7d44ed85eafb4b2f93ffd2ca2ddecc19f1e0d2bec3574fe",
  "cpu_exec_space/test_cpu_exec_space_ppuio.nes": "9f7f24d420033e032f5da0e1eb721cce1d843e032b31973acddb0255ef479251",
  "ppu_open_bus/ppu_open_bus.nes": "d4208a3ff6340532dd0fced7f9d408d5b6585853a0ddc9c1f64ee1722ef08e67"
};

// Self-scored framebuffer baseline (GBA-runner style): id → rendered-frame
// SHA256. The 2005-era sprite-hit ROMs report only on screen, so we hash the
// settled framebuffer; re-record with `--bless` after a verified change.
// Shared multi-engine baseline file; this runner owns the "nes" key.
const BASELINE_PATH = resolve(__dirname, "..", "roms-baseline.json");
const bless = process.argv.includes("--bless");
const baselineFile: Record<string, unknown> = existsSync(BASELINE_PATH)
  ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, unknown>)
  : {};
const baseline: Record<string, string> = (baselineFile["nes"] ?? {}) as Record<string, string>;
const blessed: Record<string, string> = { ...baseline };

const filter = process.argv
  .slice(2)
  .find((a) => !a.startsWith("--"))
  ?.toLowerCase();

async function fetchCached(repoPath: string): Promise<Buffer> {
  const dest = resolve(CACHE, repoPath);
  const want = SHA256[repoPath];
  if (existsSync(dest)) {
    const buf = readFileSync(dest);
    if (!want || sha256(buf) === want) return buf;
    process.stdout.write(`[stale] ${repoPath} — cached hash mismatch, refetching\n`);
  }
  const url = `${BASE_URL}/${repoPath}`;
  process.stdout.write(`[fetch] ${repoPath}\n        ↳ ${url}\n`);
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (glowboot-test-runner)" }
  });
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (want && sha256(buf) !== want) {
    throw new Error(`${repoPath}: SHA256 mismatch (got ${sha256(buf)}, want ${want})`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  return buf;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// Marker recording the commit whose suites have been fully mirrored into the
// cache, so the enumeration + bulk download only runs once per pin (or after a
// COMMIT bump). Lives inside the gitignored cache.
const SUITES_MARKER = resolve(CACHE, ".suites-complete");

/** Top-level suite folders to mirror in full: every directory the runner scores
 *  (from the pinned SHA map) plus any already present in the cache. `other` is
 *  excluded — it's an upstream grab-bag of unrelated demos, and we only use
 *  `other/nestest.*`, which the per-file SHA-pinned fetch handles. */
function suiteDirs(): string[] {
  const dirs = new Set<string>();
  for (const path of Object.keys(SHA256)) dirs.add(path.split("/")[0]!);
  if (existsSync(CACHE)) {
    for (const entry of readdirSync(CACHE)) {
      if (!entry.startsWith(".") && statSync(resolve(CACHE, entry)).isDirectory()) dirs.add(entry);
    }
  }
  dirs.delete("other");
  return [...dirs].sort();
}

interface TreeEntry {
  path: string;
  type: string;
}

/** Mirror the complete contents of every suite folder we run — source, readme,
 *  and every sub-ROM, not just the scored ones — so the local suite matches
 *  upstream. Enumerates the pinned commit's tree once (one API call), then
 *  downloads any missing blob under a suite dir. Scored ROMs are still verified
 *  against {@link SHA256} when each test loads them via {@link fetchCached}. */
async function ensureSuiteFolders(): Promise<void> {
  if (existsSync(SUITES_MARKER) && readFileSync(SUITES_MARKER, "utf8").trim() === COMMIT) return;
  const dirs = new Set(suiteDirs());
  process.stdout.write(`Mirroring ${dirs.size} suite folders from ${REPO}@${COMMIT.slice(0, 7)}…\n`);
  const treeUrl = `https://api.github.com/repos/${REPO}/git/trees/${COMMIT}?recursive=1`;
  const res = await fetch(treeUrl, { headers: { "User-Agent": "Mozilla/5.0 (glowboot-test-runner)" } });
  if (!res.ok) throw new Error(`fetch tree ${treeUrl}: ${res.status} ${res.statusText}`);
  const tree = (await res.json()) as { tree: TreeEntry[]; truncated: boolean };
  if (tree.truncated) throw new Error("nes-test-roms tree truncated — cannot enumerate suites");
  const wanted = tree.tree.filter((t) => t.type === "blob" && dirs.has(t.path.split("/")[0]!));
  let fetched = 0;
  for (const blob of wanted) {
    const dest = resolve(CACHE, blob.path);
    if (existsSync(dest)) continue;
    const url = `${BASE_URL}/${blob.path.split("/").map(encodeURIComponent).join("/")}`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (glowboot-test-runner)" } });
    if (!r.ok) throw new Error(`fetch ${url}: ${r.status} ${r.statusText}`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    fetched++;
  }
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(SUITES_MARKER, COMMIT + "\n");
  process.stdout.write(`  ✓ ${wanted.length} files across ${dirs.size} suites (${fetched} newly downloaded)\n`);
}

/**
 * Minimal NES bus for nestest's automated mode: 2 KiB internal RAM (mirrored
 * across $0000-$1FFF) and the NROM PRG ROM mirrored across $8000-$FFFF.
 * nestest's automated path never touches the PPU/APU, so those windows read
 * back as 0 (open-bus would also do, but the trace never observes them).
 */
class NestestBus implements Bus {
  private readonly ram = new Uint8Array(0x800);
  constructor(private readonly prg: Uint8Array) {}

  read(addr: number): number {
    if (addr < 0x2000) return this.ram[addr & 0x7ff]!;
    if (addr >= 0x8000) return this.prg[(addr - 0x8000) % this.prg.length]!;
    return 0;
  }
  write(addr: number, value: number): void {
    if (addr < 0x2000) this.ram[addr & 0x7ff] = value;
  }
}

interface TraceLine {
  pc: number;
  a: number;
  x: number;
  y: number;
  p: number;
  sp: number;
  cyc: number;
}

// Nintendulator format: `C000  4C F5 C5  JMP $C5F5  A:00 X:00 Y:00 P:24 SP:FD PPU:... CYC:7`
const LOG_RE =
  /^([0-9A-F]{4})\s.*\bA:([0-9A-F]{2}) X:([0-9A-F]{2}) Y:([0-9A-F]{2}) P:([0-9A-F]{2}) SP:([0-9A-F]{2})\b.*\bCYC:(\d+)/;

function parseLog(text: string): TraceLine[] {
  const out: TraceLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = LOG_RE.exec(raw);
    if (!m) continue;
    out.push({
      pc: parseInt(m[1]!, 16),
      a: parseInt(m[2]!, 16),
      x: parseInt(m[3]!, 16),
      y: parseInt(m[4]!, 16),
      p: parseInt(m[5]!, 16),
      sp: parseInt(m[6]!, 16),
      cyc: parseInt(m[7]!, 10)
    });
  }
  return out;
}

const hex = (v: number, w: number) => v.toString(16).toUpperCase().padStart(w, "0");

function fmt(t: TraceLine): string {
  return `PC:${hex(t.pc, 4)} A:${hex(t.a, 2)} X:${hex(t.x, 2)} Y:${hex(t.y, 2)} P:${hex(t.p, 2)} SP:${hex(t.sp, 2)} CYC:${t.cyc}`;
}

async function runNestest(): Promise<boolean> {
  const nes = await fetchCached("other/nestest.nes");
  const log = parseLog((await fetchCached("other/nestest.log")).toString("latin1"));
  if (log.length === 0) throw new Error("nestest.log parsed to 0 lines — format mismatch");

  const rom = parseNesRom(new Uint8Array(nes));
  const cpu = new CPU(new NestestBus(rom.prgRom));
  cpu.reset();
  cpu.pc = 0xc000; // nestest's automated entry point
  cpu.cycles = log[0]!.cyc; // align to the golden trace's start (7)

  for (let i = 0; i < log.length; i++) {
    const exp = log[i]!;
    const got: TraceLine = {
      pc: cpu.pc,
      a: cpu.a,
      x: cpu.x,
      y: cpu.y,
      p: cpu.p,
      sp: cpu.sp,
      cyc: cpu.cycles
    };
    if (
      got.pc !== exp.pc ||
      got.a !== exp.a ||
      got.x !== exp.x ||
      got.y !== exp.y ||
      got.p !== exp.p ||
      got.sp !== exp.sp ||
      got.cyc !== exp.cyc
    ) {
      console.log(`nestest: ✗ divergence at trace line ${i + 1} / ${log.length}`);
      console.log(`  expected  ${fmt(exp)}`);
      console.log(`  got       ${fmt(got)}`);
      if (i > 0) console.log(`  prev ok   ${fmt(log[i - 1]!)}`);
      return false;
    }
    cpu.step();
  }

  console.log(`nestest: ✓ all ${log.length} instructions match (PC, regs, CPU cycles)`);
  return true;
}

/**
 * Bus for blargg's CPU test ROMs: 2 KiB RAM (mirrored), 8 KiB PRG-RAM at
 * $6000-$7FFF (where the result protocol lives), and NROM-style PRG ROM
 * mirrored across $8000-$FFFF. The only PPU behaviour modelled is the VBlank
 * flag in $2002 (set at scanline 241, cleared at pre-render and on read) plus
 * the NMI it can raise — blargg's init polls VBlank twice before testing, so
 * without it the ROM hangs. No rendering, no mapper: the instr_test-v5
 * `rom_singles` are mapper 0 and cpu_dummy_reads (mapper 3) banks only CHR, so
 * its PRG is a fixed 32 KiB just like NROM.
 */
class BlarggBus implements Bus {
  private readonly ram = new Uint8Array(0x800);
  private readonly prgRam = new Uint8Array(0x2000);
  private ppuDot = 0;
  private vblank = false;
  private nmiOutput = false;

  constructor(private readonly prg: Uint8Array) {}

  read(addr: number): number {
    if (addr < 0x2000) return this.ram[addr & 0x7ff]!;
    if (addr < 0x4000) {
      if ((addr & 7) === 2) {
        const v = this.vblank ? 0x80 : 0;
        this.vblank = false; // reading PPUSTATUS clears VBlank
        return v;
      }
      return 0;
    }
    if (addr < 0x6000) return 0; // APU / IO — unused by these tests
    if (addr < 0x8000) return this.prgRam[addr - 0x6000]!;
    return this.prg[(addr - 0x8000) % this.prg.length]!;
  }

  write(addr: number, value: number): void {
    if (addr < 0x2000) {
      this.ram[addr & 0x7ff] = value;
    } else if (addr < 0x4000) {
      if ((addr & 7) === 0) this.nmiOutput = (value & 0x80) !== 0; // PPUCTRL
    } else if (addr >= 0x6000 && addr < 0x8000) {
      this.prgRam[addr - 0x6000] = value;
    }
  }

  /** Advance VBlank timing by `cpuCycles` (3 dots each). Returns true if an NMI
   *  edge fired. A frame is 262×341 = 89342 dots; VBlank sets at 241×341+1 and
   *  clears at the pre-render line (261×341+1). Steps are ≤21 dots, so at most
   *  one event or wrap per call. */
  tickPpu(cpuCycles: number): boolean {
    let nmi = false;
    const prev = this.ppuDot;
    let next = prev + cpuCycles * 3;
    if (prev < 82182 && next >= 82182) {
      this.vblank = true;
      if (this.nmiOutput) nmi = true;
    }
    if (prev < 89002 && next >= 89002) this.vblank = false;
    if (next >= 89342) next -= 89342;
    this.ppuDot = next;
    return nmi;
  }

  // blargg result protocol at $6000: status byte, a $DE $B0 $61 validity
  // signature at $6001-$6003, and a null-terminated ASCII message at $6004.
  status(): number {
    return this.prgRam[0]!;
  }
  hasSignature(): boolean {
    return this.prgRam[1] === 0xde && this.prgRam[2] === 0xb0 && this.prgRam[3] === 0x61;
  }
  message(): string {
    let s = "";
    for (let i = 4; i < this.prgRam.length && this.prgRam[i] !== 0; i++) {
      s += String.fromCharCode(this.prgRam[i]!);
    }
    return s.trim();
  }
}

async function runBlargg(id: string, romPath: string): Promise<boolean> {
  const rom = parseNesRom(new Uint8Array(await fetchCached(romPath)));
  const bus = new BlarggBus(rom.prgRom);
  const cpu = new CPU(bus);
  cpu.reset();

  const MAX_CYCLES = 80_000_000; // ~45 s emulated; blargg CPU tests finish well under
  let started = false;
  while (cpu.cycles < MAX_CYCLES) {
    if (bus.tickPpu(cpu.step())) cpu.nmi();
    if (bus.hasSignature()) {
      const s = bus.status();
      if (s === 0x80) started = true;
      else if (started && s !== 0x81) {
        const msg = bus.message().replace(/\n/g, " / ");
        if (s === 0x00) {
          console.log(`${id}: ✓ ${msg}`);
          return true;
        }
        console.log(`${id}: ✗ (code ${s}) ${msg}`);
        return false;
      }
    }
  }
  const tail = bus.hasSignature() ? `last status ${bus.status()}` : "no result signature";
  console.log(`${id}: ✗ timeout (${tail})`);
  return false;
}

/** Classify a blargg $6000 result code. `knownBad` is the failure code we
 *  currently expect (a tracked accuracy gap): matching it is "known-bad", code 0
 *  means it improved to a pass (re-gate it), any other code is a real failure. */
function blarggVerdict(id: string, code: number, msg: string, knownBad?: number): VisualResult {
  if (code === 0x00) {
    if (knownBad !== undefined) {
      console.log(`${id}: ✗ now PASSES (was known-bad #${knownBad}) — drop the knownBad and re-gate as a pass`);
      return false;
    }
    console.log(`${id}: ✓ ${msg}`);
    return true;
  }
  if (knownBad !== undefined && code === knownBad) {
    console.log(`${id}: ⚠ known-bad — ROM reports Failed #${code}${msg ? ` (${msg})` : ""}`);
    return "known-bad";
  }
  console.log(`${id}: ✗ (code ${code}) ${msg}`);
  return false;
}

/** Run a blargg $6000-protocol ROM on the full Nes system — used for tests that
 *  need a real PPU/mapper (e.g. MMC3's A12 scanline IRQ). `knownBad` marks a
 *  tracked failure code so the gate reports it honestly without going red. */
async function runBlarggSystem(id: string, romPath: string, maxFrames = 600, knownBad?: number): Promise<VisualResult> {
  const nes = new Nes(parseNesRom(new Uint8Array(await fetchCached(romPath))));
  const c = nes.cartridge;
  const status = () => c.cpuRead(0x6000);
  const hasSig = () => c.cpuRead(0x6001) === 0xde && c.cpuRead(0x6002) === 0xb0 && c.cpuRead(0x6003) === 0x61;

  let started = false;
  for (let f = 0; f < maxFrames; f++) {
    nes.runFrame();
    if (!hasSig()) continue;
    const s = status();
    if (s === 0x80) started = true;
    else if (started && s !== 0x81) {
      let msg = "";
      for (let i = 0x6004; i < 0x7000 && c.cpuRead(i) !== 0; i++) msg += String.fromCharCode(c.cpuRead(i));
      return blarggVerdict(id, s, msg.replace(/\n/g, " / ").trim(), knownBad);
    }
  }
  console.log(`${id}: ✗ timeout (${hasSig() ? `last status ${status()}` : "no result signature"})`);
  return false;
}

/** blargg reset-protocol runner: like runBlarggSystem, but status $81 means the
 *  ROM is requesting the RESET button. blargg expects the reset ~100 ms later,
 *  so arm a short delay (a too-fast reset makes the ROM re-request) and then
 *  Nes.softReset(). Used by apu_reset / cpu_reset. */
async function runBlarggReset(id: string, romPath: string, maxFrames = 600, knownBad?: number): Promise<VisualResult> {
  const nes = new Nes(parseNesRom(new Uint8Array(await fetchCached(romPath))));
  const c = nes.cartridge;
  const status = () => c.cpuRead(0x6000);
  const hasSig = () => c.cpuRead(0x6001) === 0xde && c.cpuRead(0x6002) === 0xb0 && c.cpuRead(0x6003) === 0x61;

  const RESET_DELAY = 6; // frames (~100 ms)
  let started = false;
  let resetAt = -1;
  let resets = 0;
  for (let f = 0; f < maxFrames; f++) {
    nes.runFrame();
    if (!hasSig()) continue;
    const s = status();
    if (s === 0x80) {
      started = true;
      resetAt = -1;
    } else if (s === 0x81) {
      if (resetAt < 0) resetAt = f + RESET_DELAY;
      if (f >= resetAt && resets < 30) {
        nes.softReset();
        resets++;
        resetAt = -1;
      }
    } else if (started) {
      let msg = "";
      for (let i = 0x6004; i < 0x7000 && c.cpuRead(i) !== 0; i++) msg += String.fromCharCode(c.cpuRead(i));
      return blarggVerdict(id, s, msg.replace(/\n/g, " / ").trim(), knownBad);
    }
  }
  console.log(`${id}: ✗ timeout (${hasSig() ? `last status ${status()}` : "no result signature"})`);
  return false;
}

// instr_test-v5 rom_singles — the full per-group instruction-correctness suite
// (official + unofficial), all mapper 0.
const INSTR_TEST_V5 = [
  "01-basics",
  "02-implied",
  "03-immediate",
  "04-zero_page",
  "05-zp_xy",
  "06-absolute",
  "07-abs_xy",
  "08-ind_x",
  "09-ind_y",
  "10-branches",
  "11-stack",
  "12-jmp_jsr",
  "13-rts",
  "14-rti",
  "15-brk",
  "16-special"
];

/** A frame-matched test either matches its baseline genuinely (the ROM renders
 *  "Passed" or has no verdict text), matches a baseline that captured a *failing*
 *  screen (a tracked hardware-accuracy gap — counts toward the gate but isn't a
 *  real pass), or has drifted (improvement/regression to investigate). The
 *  $6000 / nestest / save-state runners only ever return `true`/`false`. */
type VisualResult = boolean | "known-bad";

/** The ROM's on-screen text — blargg-style ROMs render into the first
 *  nametable with tile index == ASCII. */
function screenText(nes: Nes): string {
  let text = "";
  for (let i = 0; i < 0x3c0; i++) {
    const tile = nes.cartridge.ppuRead(0x2000 + i) & 0xff;
    if (tile >= 0x20 && tile < 0x7f) text += String.fromCharCode(tile);
  }
  return text;
}

/** Extract the PASSED / FAILED verdict from the screen so a baseline that
 *  locked a failing screen is reported honestly. Returns null for graphical
 *  tests (e.g. MMC5/MMC1 banking) that print no verdict. */
function screenVerdict(text: string): string | null {
  const m = text.match(/FAILED(:? *#?\d+)?|PASSED/i);
  return m ? m[0].trim().toUpperCase() : null;
}

/** Run a ROM on the full Nes system for `frames`, then score the settled
 *  framebuffer against the blessed hash. Used for ROMs that report only on
 *  screen (no $6000 protocol). `expect` — for ROMs whose verdict is a printed
 *  CRC / value rather than a PASSED line — lists the outputs blargg accepts
 *  (hardware alignment variants); a baseline-matched screen containing none
 *  of them is a tracked accuracy gap, not a pass. */
async function runVisual(
  id: string,
  romPath: string,
  frames: number,
  region?: Region,
  expect?: readonly string[]
): Promise<VisualResult> {
  const nes = new Nes(parseNesRom(new Uint8Array(await fetchCached(romPath))), region);
  for (let f = 0; f < frames; f++) nes.runFrame();
  const fb = nes.framebuffer;
  const hash = sha256(Buffer.from(fb.buffer, fb.byteOffset, fb.length));

  if (bless) blessed[id] = hash;
  const want = baseline[id];
  if (!want) {
    console.log(`${id}: ${bless ? "blessed" : "✗ no baseline (run with --bless)"} ${hash.slice(0, 12)}`);
    return bless;
  }
  if (want === hash) {
    const text = screenText(nes);
    const verdict = screenVerdict(text);
    if (verdict?.startsWith("FAILED")) {
      console.log(`${id}: ⚠ known-bad — frame matches baseline, ROM reports ${verdict}`);
      return "known-bad";
    }
    if (expect && !expect.some((e) => text.includes(e))) {
      console.log(`${id}: ⚠ known-bad — frame matches baseline, output not in the accepted set`);
      return "known-bad";
    }
    console.log(`${id}: ✓ frame matches baseline${verdict ? ` (${verdict})` : ""}`);
    return true;
  }
  console.log(`${id}: ✗ frame changed (baseline ${want.slice(0, 12)}, got ${hash.slice(0, 12)})`);
  return false;
}

/** blargg's earliest ROMs (dmc_tests) render nothing and report only by
 *  beeping: one beep = passed, N beeps = failure code N. Count amplitude
 *  bursts in the APU output — deterministic under the headless engine, and
 *  self-scoring (no framebuffer baseline; a gray screen can't distinguish
 *  pass from fail). */
async function runBeep(id: string, romPath: string, frames: number): Promise<VisualResult> {
  const nes = new Nes(parseNesRom(new Uint8Array(await fetchCached(romPath))));
  let bursts = 0;
  let inBurst = false;
  let quiet = 0;
  nes.onAudioFrame = (left, _right, count) => {
    let peak = 0;
    for (let i = 0; i < count; i++) {
      const a = Math.abs(left[i]!);
      if (a > peak) peak = a;
    }
    if (peak > 0.02) {
      if (!inBurst) {
        inBurst = true;
        bursts++;
      }
      quiet = 0;
    } else if (inBurst && ++quiet > 3) {
      inBurst = false;
    }
  };
  for (let f = 0; f < frames; f++) nes.runFrame();
  if (bursts === 1) {
    console.log(`${id}: ✓ one beep (passed)`);
    return true;
  }
  console.log(`${id}: ✗ ${bursts} beeps (failure code ${bursts || "none"})`);
  return false;
}

/** Save/load determinism invariant: a snapshot taken at frame `warmup` must,
 *  after `tail` more frames, reproduce the exact framebuffer the uninterrupted
 *  run produces. Catches any machine state the serializer drops. Self-checking
 *  (no baseline) — the comparison is against the engine's own continuation. */
async function runSaveStateRoundTrip(id: string, romPath: string, warmup: number, tail: number): Promise<boolean> {
  const buf = new Uint8Array(await fetchCached(romPath));
  const hashAfterTail = (nes: Nes): string => {
    for (let f = 0; f < tail; f++) nes.runFrame();
    const fb = nes.framebuffer;
    return sha256(Buffer.from(fb.buffer, fb.byteOffset, fb.length));
  };

  const a = new Nes(parseNesRom(buf));
  for (let f = 0; f < warmup; f++) a.runFrame();
  const snapshot = a.saveState();
  const hashA = hashAfterTail(a);

  // A fresh machine driven out of sync, then loaded from the snapshot — its
  // continuation must match the uninterrupted run frame-for-frame.
  const b = new Nes(parseNesRom(buf));
  for (let f = 0; f < 5; f++) b.runFrame();
  b.loadState(snapshot);
  const hashB = hashAfterTail(b);

  if (hashA === hashB) {
    console.log(`${id}: ✓ save/load deterministic`);
    return true;
  }
  console.log(`${id}: ✗ save/load diverged (${hashA.slice(0, 12)} vs ${hashB.slice(0, 12)})`);
  return false;
}

// blargg sprite-hit suite (2005) — screen-output only; the NROM tests exercise
// the full BG + sprite + sprite-0-hit pipeline, and 09-11 probe the flag's
// per-dot timing. Hashes were blessed against a run whose framebuffer reads
// "PASSED" for every test.
const SPRITE_HIT = [
  "01.basics",
  "02.alignment",
  "03.corners",
  "04.flip",
  "05.left_clip",
  "06.right_edge",
  "07.screen_bottom",
  "08.double_height",
  "09.timing_basics",
  "10.timing_order",
  "11.edge_timing"
];

const TESTS: { id: string; run: () => Promise<VisualResult> }[] = [
  { id: "nestest", run: runNestest },
  ...INSTR_TEST_V5.map((name) => ({
    id: `instr_test-v5/${name}`,
    run: () => runBlargg(`instr_test-v5/${name}`, `instr_test-v5/rom_singles/${name}.nes`)
  })),
  ...SPRITE_HIT.map((name) => ({
    id: `sprite_hit/${name}`,
    run: () => runVisual(`sprite_hit/${name}`, `sprite_hit_tests_2005.10.05/${name}.nes`, 120)
  })),
  // MMC3 (mapper 4) banking + A12 scanline IRQ, on the full system. The other
  // mmc3_test_2 ROMs probe sub-dot A12 timing / the alt revision; these two
  // cover the core clocking + standard IRQ that real games rely on.
  {
    id: "mmc3/1-clocking",
    run: () => runBlarggSystem("mmc3/1-clocking", "mmc3_test_2/rom_singles/1-clocking.nes")
  },
  {
    id: "mmc3/5-MMC3",
    run: () => runBlarggSystem("mmc3/5-MMC3", "mmc3_test_2/rom_singles/5-MMC3.nes")
  },
  // Further blargg $6000 suites on the full system: CPU instruction timing /
  // misc, dummy writes (OAM + PPU memory), OAM read / stress, the basic VBlank
  // flag, and APU length-counter / IRQ-flag behaviour. The sub-dot-timing and
  // APU-frame-IRQ-on-CPU variants in these collections remain accuracy gaps and
  // aren't gated here.
  ...[
    ["instr_timing", "instr_timing/instr_timing.nes", 2500],
    ["instr_misc", "instr_misc/instr_misc.nes", 2000],
    ["cpu_dummy_writes/oam", "cpu_dummy_writes/cpu_dummy_writes_oam.nes", 2000],
    ["cpu_dummy_writes/ppumem", "cpu_dummy_writes/cpu_dummy_writes_ppumem.nes", 2000],
    ["oam_read", "oam_read/oam_read.nes", 1500],
    ["oam_stress", "oam_stress/oam_stress.nes", 4000],
    // All 10 VBlank / NMI cycle-timing sub-tests pass: line-sampled /NMI edge,
    // the $2002-read set/clear races, and the 1-cycle-deferred NMI recognition.
    ["ppu_vbl_nmi/01-basics", "ppu_vbl_nmi/rom_singles/01-vbl_basics.nes", 2000],
    ["ppu_vbl_nmi/02-set_time", "ppu_vbl_nmi/rom_singles/02-vbl_set_time.nes", 2000],
    ["ppu_vbl_nmi/03-clear_time", "ppu_vbl_nmi/rom_singles/03-vbl_clear_time.nes", 2000],
    ["ppu_vbl_nmi/04-nmi_control", "ppu_vbl_nmi/rom_singles/04-nmi_control.nes", 2000],
    ["ppu_vbl_nmi/05-nmi_timing", "ppu_vbl_nmi/rom_singles/05-nmi_timing.nes", 2000],
    ["ppu_vbl_nmi/06-suppression", "ppu_vbl_nmi/rom_singles/06-suppression.nes", 2000],
    ["ppu_vbl_nmi/07-nmi_on", "ppu_vbl_nmi/rom_singles/07-nmi_on_timing.nes", 2000],
    ["ppu_vbl_nmi/08-nmi_off", "ppu_vbl_nmi/rom_singles/08-nmi_off_timing.nes", 2000],
    ["ppu_vbl_nmi/09-even_odd", "ppu_vbl_nmi/rom_singles/09-even_odd_frames.nes", 2000],
    ["ppu_vbl_nmi/10-even_odd_time", "ppu_vbl_nmi/rom_singles/10-even_odd_timing.nes", 2000],
    ["apu/1-len_ctr", "apu_test/rom_singles/1-len_ctr.nes", 1500],
    ["apu/2-len_table", "apu_test/rom_singles/2-len_table.nes", 1500],
    ["apu/3-irq_flag", "apu_test/rom_singles/3-irq_flag.nes", 1500],
    ["apu/4-jitter", "apu_test/rom_singles/4-jitter.nes", 1500],
    ["apu/5-len_timing", "apu_test/rom_singles/5-len_timing.nes", 1500],
    ["apu/6-irq_flag_timing", "apu_test/rom_singles/6-irq_flag_timing.nes", 1500],
    ["apu/8-dmc_rates", "apu_test/rom_singles/8-dmc_rates.nes", 1500],
    // 7-dmc_basics #19 passes via the one-byte sample buffer: the memory reader
    // refills it the moment it empties, so a $4015 enable drains bytesRemaining
    // immediately if the buffer was empty (but leaves it if a byte is buffered).
    ["apu/7-dmc_basics", "apu_test/rom_singles/7-dmc_basics.nes", 1500],
    // The full cpu_interrupts_v2 suite via the per-cycle interrupt poll-point
    // model: CLI takes effect one instruction late; NMI hijacks a BRK and IRQ
    // vectoring; IRQ timing is exact across sprite DMA; a taken non-page-crossing
    // branch ignores an IRQ in its last cycle.
    ["cpu_interrupts/1-cli_latency", "cpu_interrupts_v2/rom_singles/1-cli_latency.nes", 1500],
    ["cpu_interrupts/2-nmi_and_brk", "cpu_interrupts_v2/rom_singles/2-nmi_and_brk.nes", 1500],
    ["cpu_interrupts/3-nmi_and_irq", "cpu_interrupts_v2/rom_singles/3-nmi_and_irq.nes", 1500],
    ["cpu_interrupts/4-irq_and_dma", "cpu_interrupts_v2/rom_singles/4-irq_and_dma.nes", 1500],
    ["cpu_interrupts/5-branch_delays", "cpu_interrupts_v2/rom_singles/5-branch_delays_irq.nes", 1500],
    // Comprehensive PPU $2007 read-buffer + open-bus + DMA/sprite-0 interplay.
    ["ppu_read_buffer", "ppu_read_buffer/test_ppu_read_buffer.nes", 2500],
    // Open-bus decay: the I/O latch drains to 0 within a second, and partial
    // reads ($2002 top 3 bits, palette $2007 low 6) leave the rest decaying.
    ["ppu_open_bus", "ppu_open_bus/ppu_open_bus.nes", 2000],
    // Executing code from PPU I/O space: open-bus reads feed the opcode stream
    // and one-byte opcodes (RTS/RTI/BRK) dummy-read the following byte ($2002).
    ["cpu_exec_space/ppuio", "cpu_exec_space/test_cpu_exec_space_ppuio.nes", 1500],
    // Executing from APU I/O space: write-only ports + unallocated $4018-$40FF
    // (and the $4020-$5FFF expansion region) read back the CPU open bus.
    ["cpu_exec_space/apu", "cpu_exec_space/test_cpu_exec_space_apu.nes", 1500]
  ].map(([id, path, frames, knownBad]) => ({
    id: id as string,
    run: () => runBlarggSystem(id as string, path as string, frames as number, knownBad as number | undefined)
  })),
  // Reset-button behaviour via Nes.softReset() on the $81 reset request: the APU
  // clears $4015 / frame-IRQ at reset, the CPU re-vectors with SP-=3 and RAM
  // preserved. 4017_timing / 4017_written verify the power/reset frame-counter
  // startup phase (as if $00 was written to $4017 a few clocks before reset).
  ...[
    ["apu_reset/4015_cleared", "apu_reset/4015_cleared.nes", 600],
    ["apu_reset/irq_flag_cleared", "apu_reset/irq_flag_cleared.nes", 600],
    ["apu_reset/len_ctrs_enabled", "apu_reset/len_ctrs_enabled.nes", 600],
    ["apu_reset/works_immediately", "apu_reset/works_immediately.nes", 600],
    ["apu_reset/4017_timing", "apu_reset/4017_timing.nes", 600],
    ["apu_reset/4017_written", "apu_reset/4017_written.nes", 600],
    ["cpu_reset/registers", "cpu_reset/registers.nes", 600],
    ["cpu_reset/ram_after_reset", "cpu_reset/ram_after_reset.nes", 600]
  ].map(([id, path, frames, knownBad]) => ({
    id: id as string,
    run: () => runBlarggReset(id as string, path as string, frames as number, knownBad as number | undefined)
  })),
  // Mapper test ROMs with on-screen result text, self-scored by framebuffer
  // hash (like sprite-hit). The blessed frame captures the rendered verdict, so
  // the gate flags both regressions and improvements (re-bless after either).
  // mmc3_irq 1/2/3/4/6 render PASSED — the counter clocks from the per-dot
  // A12 fetch stream (sprite-slot fetches at dots 257-320, the pre-render
  // line's 241st clock, $2006/$2007 bus edges). 5.MMC3_rev_A renders FAILED by
  // design: it probes the revision-A reload quirk, the opposite of the rev-B
  // behaviour real games (and 6.MMC3_rev_B) rely on — one mapper can't pass
  // both. mmc5test exercises MMC5 CHR banking; mmc1 exercises MMC1 banking +
  // a WRAM-disable scanline counter.
  ...[
    ["mmc3_irq/1.Clocking", "mmc3_irq_tests/1.Clocking.nes", 600],
    ["mmc3_irq/2.Details", "mmc3_irq_tests/2.Details.nes", 600],
    ["mmc3_irq/3.A12_clocking", "mmc3_irq_tests/3.A12_clocking.nes", 600],
    ["mmc3_irq/4.Scanline_timing", "mmc3_irq_tests/4.Scanline_timing.nes", 600],
    ["mmc3_irq/5.MMC3_rev_A", "mmc3_irq_tests/5.MMC3_rev_A.nes", 600],
    ["mmc3_irq/6.MMC3_rev_B", "mmc3_irq_tests/6.MMC3_rev_B.nes", 600],
    ["mmc5/chr_bank", "mmc5test_v2/mmc5test.nes", 240],
    ["mmc1/wram_a12", "MMC1_A12/mmc1_a12.nes", 240],
    // Visual "Passed" screen — guards the CPU indexed dummy-read implementation.
    ["cpu/dummy_reads", "cpu_dummy_reads/cpu_dummy_reads.nes", 120],
    // Sprite-overflow flag (screen-only verdict). The flag is evaluated
    // cycle-exactly (dot-65 schedule incl. the diagonal-scan hardware bug), so
    // all five render PASSED.
    ["sprite_overflow/1.Basics", "sprite_overflow_tests/1.Basics.nes", 300],
    ["sprite_overflow/2.Details", "sprite_overflow_tests/2.Details.nes", 300],
    ["sprite_overflow/3.Timing", "sprite_overflow_tests/3.Timing.nes", 300],
    ["sprite_overflow/4.Obscure", "sprite_overflow_tests/4.Obscure.nes", 300],
    ["sprite_overflow/5.Emulator", "sprite_overflow_tests/5.Emulator.nes", 300],
    // The older blargg VBlank/NMI suite — all 7 render PASSED, a second-author
    // check on the same cycle-timing the ppu_vbl_nmi suite covers.
    ["vbl_nmi_timing/1.frame_basics", "vbl_nmi_timing/1.frame_basics.nes", 300],
    ["vbl_nmi_timing/2.vbl_timing", "vbl_nmi_timing/2.vbl_timing.nes", 300],
    ["vbl_nmi_timing/3.even_odd_frames", "vbl_nmi_timing/3.even_odd_frames.nes", 300],
    ["vbl_nmi_timing/4.vbl_clear_timing", "vbl_nmi_timing/4.vbl_clear_timing.nes", 300],
    ["vbl_nmi_timing/5.nmi_suppression", "vbl_nmi_timing/5.nmi_suppression.nes", 300],
    ["vbl_nmi_timing/6.nmi_disable", "vbl_nmi_timing/6.nmi_disable.nes", 300],
    ["vbl_nmi_timing/7.nmi_timing", "vbl_nmi_timing/7.nmi_timing.nes", 300],
    // blargg's 2005 PPU set (screen result code 1 == passed): palette-RAM
    // mirroring, sprite-RAM access + $4014 DMA, and $2007 VRAM access.
    ["blargg_ppu/palette_ram", "blargg_ppu_tests_2005.09.15b/palette_ram.nes", 240],
    ["blargg_ppu/sprite_ram", "blargg_ppu_tests_2005.09.15b/sprite_ram.nes", 240],
    ["blargg_ppu/vram_access", "blargg_ppu_tests_2005.09.15b/vram_access.nes", 240],
    // Standalone branch-timing set (2005) — taken/untaken/page-cross cycle
    // counts, a second-author check on cpu_interrupts/5-branch_delays.
    ["branch_timing/1.Branch_Basics", "branch_timing_tests/1.Branch_Basics.nes", 300],
    ["branch_timing/2.Backward_Branch", "branch_timing_tests/2.Backward_Branch.nes", 300],
    ["branch_timing/3.Forward_Branch", "branch_timing_tests/3.Forward_Branch.nes", 300],
    // Every official + unofficial instruction's cycle count (takes ~16 s of
    // emulated time before the verdict settles).
    ["cpu_timing_test6", "cpu_timing_test6/cpu_timing_test.nes", 1300],
    // blargg's combined CPU functional test — broad redundancy over nestest +
    // instr_test-v5 (official.nes is the official-opcode-only variant).
    ["blargg_cpu5/official", "blargg_nes_cpu_test5/official.nes", 1300],
    ["blargg_cpu5/cpu", "blargg_nes_cpu_test5/cpu.nes", 1300],
    // MMC5 ExRAM canary (Quietust): code copied into ExRAM at startup and
    // executed from $5C00 each VBlank drives a raster palette effect. No
    // verdict text — the hash locks the (deterministic) frame like
    // mmc5/chr_bank.
    ["mmc5/exram", "exram/mmc5exram.nes", 300]
    // (read_joy3 is not gated: test_buttons needs a human hand, count_errors
    // only tallies conflicts — vacuous while the DPCM controller bit deletion
    // is deliberately unemulated — and thorough_test's sync_dmc harness hits
    // the same phase-attractor divergence as the ungated dmc_dma ROMs.)
  ].map(([id, path, frames]) => ({
    id: id as string,
    run: () => runVisual(id as string, path as string, frames as number)
  })),
  // DMC DMA cycle stealing. The stall totals (reload 4 / load 3 cycles, the
  // rates blargg's apu/8-dmc_rates times) and the repeated-read side effects
  // are emulated; write cycles are unaffected. dma_2007_read / dma_2007_write
  // / dma_4016_read are not gated: their sync_dmc harness has two
  // self-consistent phase attractors and our engine settles into the one
  // whose per-iteration steal is 3 (hardware settles into the 4 attractor),
  // so the sync loop never converges — a tracked gap alongside the
  // deliberately-unemulated DPCM controller bit deletion (see the CPU's DMC
  // stall). double_2007_read completes and gates against blargg's accepted
  // CRC set.
  {
    id: "dmc_dma/double_2007_read",
    run: () =>
      runVisual("dmc_dma/double_2007_read", "dmc_dma_during_read4/double_2007_read.nes", 1000, undefined, [
        "85CFD627",
        "F018C287",
        "440EF923",
        "E52F41A5"
      ])
  },
  {
    id: "dmc_dma/read_write_2007",
    run: () => runVisual("dmc_dma/read_write_2007", "dmc_dma_during_read4/read_write_2007.nes", 1000)
  },
  // PAL APU length-counter / frame-IRQ timing — screen-only verdict, run in PAL
  // region (these ROMs are PAL-only). All ten render PASSED: 10.len_halt_timing
  // and 11.len_reload_timing pass via the deferred length halt/reload model (the
  // $400x halt/$400x+3 reload write takes effect only after the next length clock).
  ...[
    ["pal_apu/01.len_ctr", "pal_apu_tests/01.len_ctr.nes", 600],
    ["pal_apu/02.len_table", "pal_apu_tests/02.len_table.nes", 600],
    ["pal_apu/03.irq_flag", "pal_apu_tests/03.irq_flag.nes", 600],
    ["pal_apu/04.clock_jitter", "pal_apu_tests/04.clock_jitter.nes", 600],
    ["pal_apu/05.len_timing_mode0", "pal_apu_tests/05.len_timing_mode0.nes", 600],
    ["pal_apu/06.len_timing_mode1", "pal_apu_tests/06.len_timing_mode1.nes", 600],
    ["pal_apu/07.irq_flag_timing", "pal_apu_tests/07.irq_flag_timing.nes", 600],
    ["pal_apu/08.irq_timing", "pal_apu_tests/08.irq_timing.nes", 600],
    ["pal_apu/10.len_halt_timing", "pal_apu_tests/10.len_halt_timing.nes", 600],
    ["pal_apu/11.len_reload_timing", "pal_apu_tests/11.len_reload_timing.nes", 600]
  ].map(([id, path, frames]) => ({
    id: id as string,
    run: () => runVisual(id as string, path as string, frames as number, "pal")
  })),
  // DMC channel edges (blargg, beep-only verdict): sample-buffer retention,
  // DMA latency, $4015 status, and the DMC IRQ.
  ...[
    ["dmc/buffer_retained", "dmc_tests/buffer_retained.nes", 600],
    ["dmc/latency", "dmc_tests/latency.nes", 600],
    ["dmc/status", "dmc_tests/status.nes", 600],
    ["dmc/status_irq", "dmc_tests/status_irq.nes", 600]
  ].map(([id, path, frames]) => ({
    id: id as string,
    run: () => runBeep(id as string, path as string, frames as number)
  })),
  // Save-state determinism across mapper families (NROM/MMC1/MMC3/MMC5): a
  // mid-run snapshot must reproduce the uninterrupted framebuffer. Self-checking
  // — guards the serializer against dropped CPU/PPU/APU/mapper state.
  ...[
    ["savestate/nrom", "sprite_hit_tests_2005.10.05/01.basics.nes", 90, 30],
    ["savestate/mmc1", "MMC1_A12/mmc1_a12.nes", 150, 30],
    ["savestate/mmc3", "mmc3_irq_tests/1.Clocking.nes", 150, 60],
    ["savestate/mmc5", "mmc5test_v2/mmc5test.nes", 150, 30]
  ].map(([id, path, warmup, tail]) => ({
    id: id as string,
    run: () => runSaveStateRoundTrip(id as string, path as string, warmup as number, tail as number)
  }))
];

async function main(): Promise<void> {
  const selected = filter ? TESTS.filter((t) => t.id.includes(filter)) : TESTS;
  if (selected.length === 0) {
    console.log(`no tests match "${filter}"`);
    process.exit(1);
  }

  await ensureSuiteFolders();

  let pass = 0;
  let knownBad = 0;
  let fail = 0;
  for (const t of selected) {
    try {
      const result = await t.run();
      if (result === "known-bad") knownBad++;
      else if (result) pass++;
      else fail++;
    } catch (err) {
      console.log(`${t.id}: crashed — ${err instanceof Error ? err.message : String(err)}`);
      fail++;
    }
  }
  if (bless) {
    baselineFile["nes"] = blessed;
    writeFileSync(BASELINE_PATH, JSON.stringify(baselineFile, null, 2) + "\n");
    console.log(`\nblessed ${Object.keys(blessed).length} framebuffer baseline(s)`);
  }
  // known-bad entries match a baseline that captured a failing screen — a tracked
  // accuracy gap, not a real pass — so they don't fail the gate but are reported
  // separately. The gate only goes red on `fail` (a genuine failure or drift).
  const kb = knownBad > 0 ? ` · ${knownBad} known-bad (tracked)` : "";
  console.log(`\n${pass} passing${kb} · ${fail} failing  —  ${pass + knownBad}/${selected.length} baselines OK`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();

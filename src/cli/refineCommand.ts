import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { deliverToCmux } from "../refine/cmuxDelivery.js";
import { discoverProviders, REASONING_EFFORTS } from "../refine/providerModels.js";
import { refinePrompt } from "../refine/refineAttempts.js";
import { readConfig } from "../settings/configFile.js";
import { refineProviders } from "../settings/configSchema.js";
import { CliUsageError } from "./cliUsageError.js";
import { speakAloud } from "./speakCommand.js";
import * as TerminalUI from "./TerminalUI.js";

const refineOptions = {
  prompt: Args.text({ name: "prompt" }).pipe(Args.withDescription("The draft prompt to refine"), Args.optional),
  speak: Options.boolean("speak").pipe(Options.withDescription("Read the refined prompt aloud")),
  provider: Options.choice("provider", refineProviders).pipe(
    Options.withDescription("Provider for this run (default: refine-provider)"),
    Options.optional,
  ),
  model: Options.text("model").pipe(
    Options.withDescription("Model for this run (default: refine-model)"),
    Options.optional,
  ),
  effort: Options.choice("effort", REASONING_EFFORTS).pipe(
    Options.withDescription("Reasoning effort for this run (default: refine-effort)"),
    Options.optional,
  ),
  sendTo: Options.choice("send-to", ["caret", "cmux-new", "cmux-resume"] as const).pipe(
    Options.withDescription("Also send the result to cmux (caret only prints it)"),
    Options.optional,
  ),
  cmuxCommand: Options.text("cmux-command").pipe(
    Options.withDescription("Command template for cmux-new ({{prompt_file}}, {{prompt}}, {{cwd}}, each shell-quoted)"),
    Options.optional,
  ),
  pressEnter: Options.boolean("press-enter").pipe(Options.withDescription("Press Enter after sending to cmux")),
  listProviders: Options.boolean("list-providers").pipe(
    Options.withDescription("Print the agent CLIs found on this Mac and their models as JSON, then exit"),
  ),
};

export const refineCommand = Command.make("refine", refineOptions, (args) =>
  Effect.gen(function* () {
    if (args.listProviders) {
      const providers = yield* discoverProviders({ refresh: true });
      return yield* TerminalUI.json({ providers });
    }

    const draft = Option.getOrElse(args.prompt, () => "");
    if (draft.trim() === "") {
      return yield* new CliUsageError({ issue: "Pass the prompt to refine, or --list-providers." });
    }

    const saved = yield* readConfig;
    const config = {
      ...saved,
      refineProvider: Option.getOrElse(args.provider, () => saved.refineProvider),
      refineSendTo: Option.getOrElse(args.sendTo, () => saved.refineSendTo),
      refineCmuxCommand: Option.getOrElse(args.cmuxCommand, () => saved.refineCmuxCommand),
      refineCmuxPressEnter: args.pressEnter || saved.refineCmuxPressEnter,
    };
    const refined = yield* refinePrompt({
      draft,
      provider: config.refineProvider,
      model: Option.getOrElse(args.model, () => config.refineModel || ""),
      effort: Option.getOrElse(args.effort, () => config.refineEffort || ""),
      allowPicker: true,
      log: () => undefined,
    });
    yield* TerminalUI.text(refined);
    if (args.speak) {
      yield* speakAloud(refined, config);
    }

    if (config.refineSendTo === "caret") {
      return;
    }

    const delivery = yield* deliverToCmux({ text: refined, config });
    yield* TerminalUI.detail(delivery);
  }),
).pipe(Command.withDescription("Refine one prompt with an agent CLI (codex, claude, grok, …) and print the result"));

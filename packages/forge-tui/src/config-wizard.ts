import blessed from 'blessed'
import { initConfig } from './config-helper.js'
import type { ForgeConfigFile, ProviderName } from '@forge/types'

export interface WizardResult {
  config: ForgeConfigFile
  cancelled: boolean
}

export class ConfigWizard {
  private screen: any
  private result: WizardResult = { config: {} as any, cancelled: false }

  private providerNames: ProviderName[] = ['openrouter', 'ollama', 'openai', 'anthropic', 'ollama-cloud', 'minimax']
  private selectedProvider!: ProviderName
  private selectedModel!: string

  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Forge Setup',
    })
  }

  async start(): Promise<WizardResult> {
    return new Promise((resolve) => {
      this.showWelcome(resolve)
    })
  }

  private makeScreen(title: string): any {
    if (this.screen) {
      this.screen.destroy()
    }
    this.screen = blessed.screen({
      smartCSR: true,
      title,
    })
    return this.screen
  }

  private showWelcome(resolve: (r: WizardResult) => void): void {
    const screen = this.makeScreen('Forge Setup')

    blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 60,
      height: 12,
      content: [
        '',
        '  {bold}⚒  FORGE SETUP{/bold}',
        '',
        '  Welcome to Forge — the long-horizon',
        '  software engineering agent.',
        '',
        '  Let\'s configure your provider and API key.',
        '',
        '  Press {bold}Enter{/bold} to continue or {bold}q{/bold} to quit.',
      ].join('\n'),
      style: { fg: 'white', bg: 'black' },
      tags: true,
      border: { type: 'line' },
      align: 'center',
    })

    screen.key(['enter', ' '], () => {
      screen.destroy()
      this.showProviderSelect(resolve)
    })

    screen.key(['q', 'C-c'], () => {
      this.result.cancelled = true
      screen.destroy()
      resolve(this.result)
    })

    screen.render()
  }

  private showProviderSelect(resolve: (r: WizardResult) => void): void {
    const screen = this.makeScreen('Forge Setup — Provider')

    const form = blessed.form({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 50,
      height: 16,
      keys: true,
      vi: true,
    })

    blessed.box({
      parent: form,
      top: 0,
      left: 0,
      content: ' {bold}Select Provider{/bold}',
      tags: true,
      height: 1,
    })

    const radioButtons: any[] = []
    for (let i = 0; i < this.providerNames.length; i++) {
      const rb = blessed.radiobutton({
        parent: form,
        top: 2 + i,
        left: 2,
        width: 30,
        height: 1,
        content: this.providerNames[i]!,
        checked: i === 0,
        style: { fg: 'white', bg: 'black' },
      })
      radioButtons.push(rb)
    }

    const nameInput = blessed.textbox({
      parent: form,
      top: 9,
      left: 2,
      width: 40,
      height: 1,
      inputOnFocus: true,
      style: { fg: 'white', bg: 'blue' },
      value: 'anthropic/claude-sonnet-20241022',
    })

    blessed.box({
      parent: form,
      top: 8,
      left: 2,
      content: ' Model:',
      height: 1,
      style: { fg: 'white' },
    })

    const submitBtn = blessed.button({
      parent: form,
      top: 12,
      left: 2,
      width: 20,
      height: 1,
      content: ' Next ',
      style: { fg: 'white', bg: 'blue', focus: { bg: 'green' } },
      mouse: true,
    })

    submitBtn.on('press', () => {
      const selectedIdx = radioButtons.findIndex((rb: any) => rb.checked)
      this.selectedProvider = this.providerNames[selectedIdx >= 0 ? selectedIdx : 0]!
      this.selectedModel = nameInput.value || nameInput.content || 'anthropic/claude-sonnet-20241022'
      screen.destroy()
      this.showApiKeyForm(resolve)
    })

    screen.key(['q', 'C-c'], () => {
      this.result.cancelled = true
      screen.destroy()
      resolve(this.result)
    })

    screen.render()
  }

  private showApiKeyForm(resolve: (r: WizardResult) => void): void {
    const screen = this.makeScreen('Forge Setup — API Key')

    const provider = this.selectedProvider
    const model = this.selectedModel
    const needsKey = provider !== 'ollama' && provider !== 'ollama-cloud'

    const form = blessed.form({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 60,
      height: 14,
      keys: true,
    })

    blessed.box({
      parent: form,
      top: 0,
      left: 0,
      content: ` {bold}Configure ${provider}{/bold}`,
      tags: true,
      height: 1,
    })

    blessed.box({
      parent: form,
      top: 2,
      left: 2,
      content: ` Provider: ${provider}`,
      height: 1,
    })

    blessed.box({
      parent: form,
      top: 3,
      left: 2,
      content: ` Model: ${model}`,
      height: 1,
    })

    let apiKeyInput: any

    if (needsKey) {
      blessed.box({
        parent: form,
        top: 5,
        left: 2,
        content: ' API Key (sk-...):',
        height: 1,
      })

      apiKeyInput = blessed.textbox({
        parent: form,
        top: 6,
        left: 2,
        width: 50,
        height: 1,
        inputOnFocus: true,
        style: { fg: 'white', bg: 'blue' },
        censor: true,
      })
    }

    const saveBtn = blessed.button({
      parent: form,
      top: needsKey ? 9 : 6,
      left: 2,
      width: 20,
      height: 1,
      content: ' Save & Finish ',
      style: { fg: 'white', bg: 'blue', focus: { bg: 'green' } },
      mouse: true,
    })

    saveBtn.on('press', async () => {
      const fileConfig: ForgeConfigFile = {
        provider: {
          name: provider,
          model,
          apiKey: apiKeyInput?.value || apiKeyInput?.content || undefined,
        },
        mode: 'implement',
        logLevel: 'info',
      }

      try {
        await initConfig(fileConfig)
        this.result.config = fileConfig
        screen.destroy()
        this.showSaved(resolve)
      } catch (err) {
        this.showError(screen, err)
      }
    })

    screen.key(['q', 'C-c'], () => {
      this.result.cancelled = true
      screen.destroy()
      resolve(this.result)
    })

    screen.render()
  }

  private showSaved(resolve: (r: WizardResult) => void): void {
    const screen = this.makeScreen('Forge Setup — Complete')

    blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 40,
      height: 5,
      content: '\n {green-fg}✓{/green-fg} Configuration saved!\n\n Press any key to continue.',
      tags: true,
      style: { fg: 'white', bg: 'black' },
      border: { type: 'line' },
      align: 'center',
    })

    screen.render()

    screen.once('keypress', () => {
      screen.destroy()
      resolve(this.result)
    })
  }

  private showError(screen: any, err: unknown): void {
    screen.destroy()
    const errorScreen = this.makeScreen('Forge Setup — Error')
    blessed.box({
      parent: errorScreen,
      top: 'center',
      left: 'center',
      width: 40,
      height: 5,
      content: `\n {red-fg}Error:{/red-fg} ${err}\n\n Press any key.`,
      tags: true,
      style: { fg: 'white', bg: 'black' },
      border: { type: 'line' },
      align: 'center',
    })
    errorScreen.render()
    errorScreen.once('keypress', () => {
      errorScreen.destroy()
      this.result.cancelled = true
      // resolve is not called here — error is terminal
    })
  }
}

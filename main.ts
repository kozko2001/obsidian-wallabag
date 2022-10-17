import { App, Editor, MarkdownView, MetadataCache, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, Vault } from 'obsidian';
import { NodeHtmlMarkdown, NodeHtmlMarkdownOptions } from 'node-html-markdown'
import path from 'path';
import sanitize from 'sanitize-filename';
import * as matter from 'gray-matter';
import { Secret } from './secret';
// Remember to rename these classes and interfaces!

interface MyPluginSettings {
  mySetting: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
  mySetting: 'default'
}

type AuthResponseError = {
  error: string,
  error_description: string
}

export type AuthResponseSuccess = {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  token_type: 'bearer';
};


type AuthResponse = AuthResponseError | AuthResponseSuccess

type WallabagEntriesPaginationResponse = {
  limit: number;
  page: number;
  pages: number;
  _embedded: {
    items: WallabagEntry[]
  }
}

type WallabagEntry = {
  is_archived: 0 | 1;
  is_starred: 0 | 1;
  tags: string[];
  title: string;
  url: string;
  created_at: string;
  domain: string;
  id: number;
  content: string;
}

function isResponseError(result: any): result is AuthResponseError {
  return typeof result === 'object' && typeof result.error === 'string'
}

function toMarkdown(entry: WallabagEntry): WallabagEntry {
  return {
    ...entry,
    content: NodeHtmlMarkdown.translate(entry.content),
  }
}

class WallabagFileManager {
  constructor(private vault: Vault, private metadataCache: MetadataCache) { }

  async sync(entry: WallabagEntry) {
    const files: TFile[] = this.vault.getMarkdownFiles()
    const path = this.filePath(entry)

    const existingFile: TFile | undefined = files.find(p => p.path === path)
    const content = this.content(entry)

    if (existingFile) {
      await this.vault.modify(existingFile, content)
    } else {
      await this.vault.create(path, content);
    }
  }

  filePath(entry: WallabagEntry): string {
    const folder = "wallabag/"
    let filename: string = sanitize(entry.title)
    if (filename.length > 190) {
      filename = filename.slice(0, 190);
    }

    return path.join(folder, `${filename}.md`)
  }

  content(entry: WallabagEntry): string {
    return matter.stringify(entry.content, {
      title: entry.title,
      url: entry.url,
      starred: entry.is_starred,
      tags: entry.tags,
      to_read: entry.tags.includes("TO_READ")
    });
  }

}

class WallabagAPI {
  constructor(
    private clientId: string,
    private clientSecret: string,
    private username: string,
    private password: string,
  ) { }

  async auth() {
    const body = {
      grant_type: 'password',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      username: this.username,
      password: this.password,
    }
    const domain = 'wallabag.coscolla.net';

    const url = `https://${domain}/oauth/v2/token`;

    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' }
    });

    const data: AuthResponse = await response.json() as AuthResponse

    if (isResponseError(data)) {
      console.log("error...", data.error_description)
      throw new Error(data.error_description);
    }

    return data
  }

  async fetchEntries(auth: AuthResponseSuccess): Promise<WallabagEntry[]> {
    const domain = 'wallabag.coscolla.net';
    const url = `https://${domain}/api/entries.json`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${auth.access_token}` }
    });

    const data = await response.json() as WallabagEntriesPaginationResponse
    console.log(data)

    return data._embedded.items;
  }
}

export default class MyPlugin extends Plugin {
  settings: MyPluginSettings;

  async onload() {
    await this.loadSettings();

    // This creates an icon in the left ribbon.
    const ribbonIconEl = this.addRibbonIcon('dice', 'Wallabag plugin', (_: MouseEvent) => {
      // Called when the user clicks the icon.
      new Notice('Wallabag plugin notice');

    });
    // Perform additional things with the ribbon
    ribbonIconEl.addClass('my-plugin-ribbon-class');

    // This adds a status bar item to the bottom of the app. Does not work on mobile apps.
    const statusBarItemEl = this.addStatusBarItem();
    statusBarItemEl.setText('wallabag Status Bar Text');

    // This adds a simple command that can be triggered anywhere
    this.addCommand({
      id: 'wallabag-open-sample-modal-simple',
      name: 'wallabag simple model',
      callback: async () => {
        const secrets = new Secret()
        const api = new WallabagAPI(secrets.clientId, secrets.clientSecret, secrets.username, secrets.password)

        const entries = await api.auth()
          .then(api.fetchEntries)
          .then(entries => entries.filter(entry => entry.is_archived == 0))
          .then(entries => entries.map(toMarkdown));

        Promise.all(entries.map((entry) => {
          console.log(entry);
          const fileManager = new WallabagFileManager(this.app.vault, this.app.metadataCache);

          fileManager.sync(entry)
            .then(() => console.log("file created?"))
            .catch(x => console.log("error", x))
        }))


        new SampleModal(this.app).open();
      }
    });
    // This adds an editor command that can perform some operation on the current editor instance
    this.addCommand({
      id: 'sample-editor-command',
      name: 'Sample editor command',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        console.log(editor.getSelection());
        editor.replaceSelection('Sample Editor Command');
      }
    });
    // This adds a complex command that can check whether the current state of the app allows execution of the command
    this.addCommand({
      id: 'open-sample-modal-complex',
      name: 'Open sample modal (complex)',
      checkCallback: (checking: boolean) => {
        // Conditions to check
        const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (markdownView) {
          // If checking is true, we're simply "checking" if the command can be run.
          // If checking is false, then we want to actually perform the operation.
          if (!checking) {
            new SampleModal(this.app).open();
          }

          // This command will only show up in Command Palette when the check function returns true
          return true;
        }
      }
    });

    // This adds a settings tab so the user can configure various aspects of the plugin
    this.addSettingTab(new SampleSettingTab(this.app, this));

    // If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
    // Using this function will automatically remove the event listener when this plugin is disabled.
    this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
      console.log('click', evt);
    });

    // When registering intervals, this function will automatically clear the interval when the plugin is disabled.
    this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
  }

  onunload() {

  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class SampleModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.setText('Woah kzk!');
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class SampleSettingTab extends PluginSettingTab {
  plugin: MyPlugin;

  constructor(app: App, plugin: MyPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl('h2', { text: 'Settings for wallabag awesome plugin.' });

    new Setting(containerEl)
      .setName('Setting #1')
      .setDesc('It\'s a secret')
      .addText(text => text
        .setPlaceholder('Enter your secret')
        .setValue(this.plugin.settings.mySetting)
        .onChange(async (value) => {
          console.log('Secret: ' + value);
          this.plugin.settings.mySetting = value;
          await this.plugin.saveSettings();
        }));
  }
}

declare module "app-info-parser" {
  export default class AppInfoParser {
    constructor(file: string);
    parse(): Promise<{ application?: { label?: string | string[] }; icon?: string; versionName?: string; versionCode?: number | string }>;
  }
}

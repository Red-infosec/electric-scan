/*
  Electric Scan
  Copyright (C) 2019  Bishop Fox

  This program is free software; you can redistribute it and/or
  modify it under the terms of the GNU General Public License
  as published by the Free Software Foundation; either version 2
  of the License, or (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program; if not, write to the Free Software
  Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
--------------------------------------------------------------------------

Maps IPC calls to RPC calls, and provides other local operations such as
listing/selecting configs to the sandboxed code.

*/

import { ipcMain, dialog, FileFilter, BrowserWindow, IpcMainEvent } from 'electron';
import { homedir } from 'os';
import * as base64 from 'base64-arraybuffer';
import * as fs from 'fs';
import * as path from 'path';
import * as Ajv from 'ajv';

import { ElectricScanner } from '../scanner';


export interface ReadFileReq {
  title: string;
  message: string;
  openDirectory: boolean;
  multiSelections: boolean;
  filters: FileFilter[] | null; // { filters: [ { name: 'Custom File Type', extensions: ['as'] } ] }
}

export interface SaveFileReq {
  title: string;
  message: string;
  filename: string;
  data: string;
}

export interface IPCMessage {
  id: number;
  type: string;
  method: string; // Identifies the target method and in the response if the method call was a success/error
  data: string;
}

// jsonSchema - A JSON Schema decorator, somewhat redundant given we're using TypeScript
// but it provides a stricter method of validating incoming JSON messages than simply
// casting the result of JSON.parse() to an interface.
function jsonSchema(schema: object) {
  const ajv = new Ajv({ allErrors: true });
  schema["additionalProperties"] = false;
  const validate = ajv.compile(schema);
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {

    const originalMethod = descriptor.value;
    descriptor.value = (arg: string) => {
      const valid = validate(arg);
      if (valid) {
        return originalMethod(arg);
      } else {
        console.error(validate.errors);
        return Promise.reject(`Invalid schema: ${ajv.errorsText(validate.errors)}`);
      }
    };

    return descriptor;
  };
}

// IPC Methods used to start/interact with the RPCClient
export class IPCHandlers {

  static client_exit() {
    process.on('unhandledRejection', () => { }); // STFU Node
    process.exit(0);
  }

  @jsonSchema({
    "properties": {
      "title": { "type": "string", "minLength": 1, "maxLength": 100 },
      "message": { "type": "string", "minLength": 1, "maxLength": 100 },
      "openDirectory": { "type": "boolean" },
      "multiSelections": { "type": "boolean" },
      "filter": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "extensions": {
              "type": "array",
              "items": { "type": "string" }
            }
          }
        }
      }
    },
    "required": ["title", "message"]
  })
  static async fs_readFile(req: string): Promise<string> {
    const readFileReq: ReadFileReq = JSON.parse(req);
    const dialogOptions = {
      title: readFileReq.title,
      message: readFileReq.message,
      openDirectory: readFileReq.openDirectory,
      multiSelections: readFileReq.multiSelections
    };
    const files = [];
    const open = await dialog.showOpenDialog(null, dialogOptions);
    await Promise.all(open.filePaths.map((filePath) => {
      return new Promise(async (resolve) => {
        fs.readFile(filePath, (err, data) => {
          files.push({
            filePath: filePath,
            error: err ? err.toString() : null,
            data: data ? base64.encode(data) : null
          });
          resolve(); // Failures get stored in `files` array
        });
      });
    }));
    return JSON.stringify({ files: files });
  }

  private static async readMetadata(scanPath: string): Promise<any> {
    return new Promise((resolve, reject) => {
      fs.readFile(path.join(scanPath, 'metadata.json'), (err, data) => {
        if (err) {
          return reject(err);
        }
        const metadata = JSON.parse(data.toString());
        fs.readdir(scanPath, (err, ls) => {
          if (err) {
            return reject(err);
          }
          metadata['screenshots'] = ls;
          resolve(metadata);
        });
      });
    });
  }

  static async electric_list(_: string): Promise<string> {
    const scansDir = path.join(homedir(), '.electric', 'scans');
    return new Promise((resolve, reject) => {
      fs.readdir(scansDir, async (err, ls) => {
        if (err) {
          return reject(err);
        }
        const results = {};
        for (let index = 0; index < ls.length; ++index) {
          const scanId = ls[index];
          console.log(`scanId = ${scanId}`);
          const meta = await IPCHandlers.readMetadata(path.join(scansDir, scanId));
          results[scanId] = meta;
        }
        resolve(JSON.stringify(results));
      });
    });
  }

  @jsonSchema({
    "properties": {
      "name": { "type": "string", "minLength": 1, "maxLength": 100 },
      "targets": { 
        "type": "array",
        "minLength": 1,
        "items": { "type": "string", "minLength": 1 },
        "additionalItems": false,
      },
      "maxWorkers": { "type": "number" },
      "width":  { "type": "number" },
      "height":  { "type": "number" },
      "margin":  { "type": "number" },
      "timeout":  { "type": "number" },
    },
    "required": ["name", "targets"]
  })
  static async electric_scan(req: string): Promise<string> {
    const scanReq = JSON.parse(req);
    const workers = scanReq.maxWorkers ? Math.abs(scanReq.maxWorkers || 1) : 8;
    const scanner = new ElectricScanner(workers);
    if (scanReq.width) {
      scanner.width = scanReq.width;
    }
    if (scanReq.height) {
      scanner.height = scanReq.height;
    }
    if (scanReq.margin) {
      scanner.margin = scanReq.margin;
    }
    if (scanReq.timeout) {
      scanner.timeout = scanReq.timeout;
    }
    const parentDir = path.join(homedir(), '.electric', 'scans');
    const scanId = await scanner.start(parentDir, scanReq.name, scanReq.targets);
    return JSON.stringify({ scan: scanId });
  }

  @jsonSchema({
    "properties": {
      "title": { "type": "string", "minLength": 1, "maxLength": 100 },
      "message": { "type": "string", "minLength": 1, "maxLength": 100 },
      "filename": { "type": "string", "minLength": 1 },
      "data": { "type": "string" }
    },
    "required": ["title", "message", "filename", "data"]
  })
  static fs_saveFile(req: string): Promise<string> {
    return new Promise(async (resolve, reject) => {
      const saveFileReq: SaveFileReq = JSON.parse(req);
      const dialogOptions = {
        title: saveFileReq.title,
        message: saveFileReq.message,
        defaultPath: path.join(homedir(), 'Downloads', path.basename(saveFileReq.filename)),
      };
      const save = await dialog.showSaveDialog(dialogOptions);
      console.log(`[save file] ${save.filePath}`);
      if (save.canceled) {
        return resolve('');  // Must return to stop execution
      }
      const fileOptions = {
        mode: 0o644,
        encoding: 'binary',
      };
      const data = Buffer.from(base64.decode(saveFileReq.data));
      fs.writeFile(save.filePath, data, fileOptions, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve(JSON.stringify({ filename: save.filePath }));
        }
      });
    });
  }

}

// IPC handlers must start with "namespace_" this helps ensure we do not inadvertently
// expose methods that we don't want exposed to the sandboxed code.
const prefixWhitelist = ['fs_', 'client_', 'electric_'];
async function dispatchIPC(method: string, data: string): Promise<string | null> {
  console.log(`IPC Dispatch: ${method}`);
  if (prefixWhitelist.some(prefix => method.startsWith(prefix))) {
    if (typeof IPCHandlers[method] === 'function') {
      const result: string = await IPCHandlers[method](data);
      return result;
    } else {
      return Promise.reject(`No handler for method: ${method}`);
    }
  } else {
    return Promise.reject(`Invalid method handler namespace for "${method}"`);
  }
}

export function startIPCHandlers(window: BrowserWindow) {

  ipcMain.on('ipc', async (event: IpcMainEvent, msg: IPCMessage) => {
    dispatchIPC(msg.method, msg.data).then((result: string) => {
      if (msg.id !== 0) {
        event.sender.send('ipc', {
          id: msg.id,
          type: 'response',
          method: 'success',
          data: result
        });
      }
    }).catch((err) => {
      console.error(`[startIPCHandlers] ${err}`);
      if (msg.id !== 0) {
        event.sender.send('ipc', {
          id: msg.id,
          type: 'response',
          method: 'error',
          data: err.toString()
        });
      }
    });
  });

  // This one doesn't have an event argument for some reason ...
  ipcMain.on('push', async (_: IpcMainEvent, data: string) => {
    window.webContents.send('ipc', {
      id: 0,
      type: 'push',
      method: '',
      data: data
    });
  });

}

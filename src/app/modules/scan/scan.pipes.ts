import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';

@Pipe({
  name: 'scanUrl'
})
export class ScanUrlPipe implements PipeTransform {

  constructor(private domSanitizer: DomSanitizer) { }

  transform(resultId: string, scanId: string) {
    const url = new URL(`scan://electric`);
    url.pathname = `${scanId}/${resultId}.png`;
    return this.domSanitizer.bypassSecurityTrustResourceUrl(url.toString());
  }

}
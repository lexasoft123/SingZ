import { closeSync,mkdtempSync,openSync,readFileSync,rmSync,writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach,describe,expect,it } from 'vitest'
import { writeAllSync } from '../../src/main/atomic-file'

const dirs:string[]=[]
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
describe('writeAllSync',()=>{
  it('commits every byte through 1-5 byte short writes',()=>{
    for(let chunk=1;chunk<=5;chunk++){
      const dir=mkdtempSync(join(tmpdir(),'singz-write-all-'));dirs.push(dir);const file=join(dir,`chunk-${chunk}`),fd=openSync(file,'wx')
      const bytes=Buffer.from('strict complete bytes for an atomic file')
      try{writeAllSync(fd,bytes,(handle,buffer,offset,length)=>writeSync(handle,buffer,offset,Math.min(chunk,length)))}finally{closeSync(fd)}
      expect(readFileSync(file)).toEqual(bytes)
    }
  })
  it('fails when a writer makes zero progress',()=>{
    const dir=mkdtempSync(join(tmpdir(),'singz-write-all-'));dirs.push(dir);const fd=openSync(join(dir,'zero'),'wx')
    try{expect(()=>writeAllSync(fd,Buffer.from('abc'),()=>0)).toThrow(/progress/i)}finally{closeSync(fd)}
  })
})

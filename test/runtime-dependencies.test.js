const test=require('node:test'),assert=require('node:assert/strict');
const express=require('express'),multer=require('multer'),nodemailer=require('nodemailer');
test('patched upload middleware accepts PDFs and enforces the configured size limit',async()=>{
  const app=express(),upload=multer({storage:multer.memoryStorage(),limits:{fileSize:32}});
  app.post('/upload',upload.single('file'),(req,res)=>res.json({size:req.file.size,name:req.file.originalname}));
  app.use((err,req,res,next)=>res.status(err.code==='LIMIT_FILE_SIZE'?413:500).json({error:err.code}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try{
    const form=new FormData();form.append('file',new Blob(['%PDF-1.7']), 'sample.pdf');
    const ok=await fetch(`http://127.0.0.1:${server.address().port}/upload`,{method:'POST',body:form});
    assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{size:8,name:'sample.pdf'});
    const large=new FormData();large.append('file',new Blob(['x'.repeat(100)]),'large.pdf');
    const denied=await fetch(`http://127.0.0.1:${server.address().port}/upload`,{method:'POST',body:large});assert.equal(denied.status,413);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('patched mail and ID dependencies support the application API without external delivery',async()=>{
  const info=await nodemailer.createTransport({streamTransport:true,buffer:true}).sendMail({from:'helpdesk@echel.co.in',to:'test@example.com',subject:'Echel',text:'Your shop is ready.'});
  assert.match(info.message.toString(),/Your shop is ready/);
  assert.match(require('uuid').v4(),/^[a-f0-9-]{36}$/);
});

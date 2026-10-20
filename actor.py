"""Small adapter for the existing continuous-avatar worker's fMP4 protocol."""
import asyncio,base64,contextlib,json,uuid
from websockets.asyncio.client import connect
from speech import pcm_chunks

class Actor:
    def __init__(self,url,portrait,send):
        self.url=url;self.portrait=portrait;self.send=send
        self.socket=None;self.reader=None;self.lock=asyncio.Lock();self.closing=False
    async def ensure(self):
        async with self.lock:
            if self.socket and self.reader and not self.reader.done():return
            await self.close();self.closing=False
            url=self.url.replace('http://','ws://').replace('https://','wss://')+'/actor'
            socket=await connect(url,proxy=None,max_size=4_000_000,max_queue=8,open_timeout=8,close_timeout=2)
            try:
                await socket.send(json.dumps(dict(portrait_id=self.portrait,transport='mp4')))
                ready=json.loads(await asyncio.wait_for(socket.recv(),30))
                if ready.get('type')!='ready':raise RuntimeError('Avatar worker unavailable')
            except BaseException:
                await socket.close();raise
            self.socket=socket;self.stream=uuid.uuid4().hex
            await self.send('actor_stream_start',stream_id=self.stream,mime=ready['mime'])
            self.reader=asyncio.create_task(self.receive(socket,self.stream))
    async def receive(self,socket,stream):
        sequence=0
        try:
            async for raw in socket:
                if isinstance(raw,bytes):
                    await self.send('actor_stream_chunk',stream_id=stream,seq=sequence,data=base64.b64encode(raw).decode())
                    sequence+=1
                else:
                    data=json.loads(raw);kind=data.pop('type')
                    if kind in ('cue_start','cue_end'):await self.send('actor_'+kind,stream_id=stream,**data)
                    elif kind=='error':raise RuntimeError('Avatar worker interrupted')
            if not self.closing:raise RuntimeError('Avatar stream closed')
        except asyncio.CancelledError:raise
        except Exception:
            if not self.closing:await self.send('actor_error',message='人物连接中断，请重新连接。')
    async def speak(self,client,tts,turn,text,body):
        await self.ensure()
        await self.send('actor_speech_start',turn_id=turn,stream_id=self.stream,text=text)
        await self.socket.send(json.dumps(dict(type='begin',turn_id=turn)))
        try:
            async for chunk in pcm_chunks(client,tts,body):
                await self.socket.send(chunk)
            await self.socket.send(json.dumps(dict(type='finish',turn_id=turn)))
        except BaseException:
            await self.cancel(turn);raise
    async def cancel(self,turn=None):
        if self.socket:
            with contextlib.suppress(Exception):await self.socket.send(json.dumps(dict(type='cancel',turn_id=turn)))
    async def close(self):
        self.closing=True
        if self.reader:
            self.reader.cancel()
            with contextlib.suppress(Exception,asyncio.CancelledError):await self.reader
        if self.socket:
            with contextlib.suppress(Exception):await self.socket.close()
        self.reader=None;self.socket=None

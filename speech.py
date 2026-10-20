"""The same streaming synthesis and fixed voice for both renderers."""
import base64

async def pcm_chunks(client,tts,body):
    total=0;pending=b''
    async with client.stream('POST',tts+'/v1/audio/speech',json=body) as response:
        response.raise_for_status()
        content_type=response.headers.get('content-type','').split(';')[0]
        if content_type not in ('application/octet-stream','audio/pcm','audio/raw','audio/l16'):
            raise ValueError('Expected raw PCM16 from TTS')
        async for chunk in response.aiter_bytes():
            pending+=chunk;length=len(pending)//2*2
            if not length:continue
            total+=length
            if total>45*48000:raise ValueError('Speech too long')
            for start in range(0,length,9600):
                yield pending[start:min(start+9600,length)]
            pending=pending[length:]
    if not total or pending:raise ValueError('Incomplete PCM')

async def browser_speech(client,tts,turn,text,body,send):
    await send('audio_start',turn_id=turn,text=text,sample_rate=24000,format='pcm_s16le')
    samples=0;sequence=0
    async for chunk in pcm_chunks(client,tts,body):
        await send('audio_chunk',turn_id=turn,seq=sequence,sample_offset=samples,
                   data=base64.b64encode(chunk).decode())
        samples+=len(chunk)//2;sequence+=1
    await send('audio_end',turn_id=turn,samples=samples,chunks=sequence)

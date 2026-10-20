"""Standalone chat gateway: no database, login, questionnaire, report or workflow."""
import asyncio,base64,contextlib,io,json,os,re,wave
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit
import httpx
from fastapi import FastAPI,Request,WebSocket,WebSocketDisconnect
from fastapi.responses import FileResponse,Response
from fastapi.staticfiles import StaticFiles
from actor import Actor
from chat import reply,speech_request

ROOT=Path(__file__).resolve().parent
LLM=os.getenv('LLM_URL','http://127.0.0.1:8111').rstrip('/')
TTS=os.getenv('TTS_URL','http://127.0.0.1:8154').rstrip('/')
ASR=os.getenv('ASR_URL','http://127.0.0.1:8113').rstrip('/')
PORTRAITS=os.getenv('NATURAL_AVATAR_URL','http://127.0.0.1:8170').rstrip('/')
CONTINUOUS=os.getenv('CONTINUOUS_AVATAR_URL','http://127.0.0.1:8171').rstrip('/')
PORTRAIT=os.getenv('PORTRAIT_ID','nuannuan')
if not re.fullmatch(r'[a-z0-9_-]{1,64}',PORTRAIT):raise ValueError('Invalid portrait ID')

@asynccontextmanager
async def lifespan(app):
    async with httpx.AsyncClient(timeout=httpx.Timeout(120,connect=5),trust_env=False) as client:
        app.state.client=client;yield

app=FastAPI(title='Nuan · 自由对话',docs_url=None,redoc_url=None,lifespan=lifespan)
app.mount('/static',StaticFiles(directory=ROOT/'web'),name='static')

@app.get('/')
async def index():return FileResponse(ROOT/'web/index.html')

@app.get('/api/health')
async def health():
    async def check(name,url):
        try:
            r=await app.state.client.get(url+'/health',timeout=2)
            return name,r.is_success
        except httpx.HTTPError:return name,False
    services=dict(await asyncio.gather(*(check(n,u) for n,u in
        [('chat',LLM),('voice',TTS),('hearing',ASR),('avatar',CONTINUOUS)])))
    return dict(services=services,ready=all(services.values()))

@app.get('/api/natural/portraits')
async def portraits():return dict(portraits=[dict(id=PORTRAIT)])

@app.get('/api/natural/portraits/{identifier}')
async def portrait(identifier:str):
    if identifier!=PORTRAIT:return Response(status_code=404)
    try:
        r=await app.state.client.get(PORTRAITS+'/portraits/'+PORTRAIT,timeout=8)
        r.raise_for_status()
        if not r.headers.get('content-type','').startswith('image/'):raise ValueError('Not an image')
        return Response(r.content,media_type=r.headers['content-type'],headers={'Cache-Control':'no-store'})
    except (httpx.HTTPError,ValueError):
        return FileResponse(ROOT/'web/assets/portrait.jpg')

def audio_payload(value):
    if not isinstance(value,str) or len(value)>4_000_000:raise ValueError('Recording too large')
    raw=base64.b64decode(value,validate=True)
    with wave.open(io.BytesIO(raw)) as audio:
        if (audio.getnchannels()!=1 or audio.getsampwidth()!=2 or not 8000<=audio.getframerate()<=48000
                or not .1<=audio.getnframes()/audio.getframerate()<=30):raise ValueError('Invalid recording')
    return value

@app.websocket('/ws')
async def websocket(ws:WebSocket):
    # This demo has no accounts; only the page's own origin may open a browser socket.
    origin=urlsplit(ws.headers.get('origin',''))
    if origin.scheme not in ('http','https') or origin.netloc!=ws.headers.get('host'):
        await ws.close(code=1008);return
    await ws.accept()
    history=[];task=None;active=None;send_lock=asyncio.Lock()
    async def send(kind,**data):
        async with send_lock:await ws.send_json(dict(type=kind,**data))
    actor=Actor(CONTINUOUS,PORTRAIT,send)
    async def cancel():
        nonlocal task,active
        if task and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):await task
        await actor.cancel(active);task=None;active=None
    async def run(turn,text=None,audio=None):
        try:
            if audio:
                await send('status',turn_id=turn,label='正在听清你说的话…')
                r=await app.state.client.post(ASR+'/transcribe',json=dict(audio=audio,language='Chinese'))
                r.raise_for_status();text=str(r.json().get('text','')).strip()[:1500]
                await send('transcript',turn_id=turn,text=text)
            if not text:
                await send('error',turn_id=turn,message='这次没有听到清楚的语音，可以重新说或输入文字。');return
            await send('status',turn_id=turn,label='暖暖正在想…')
            async def emit(text):await send('text',turn_id=turn,text=text)
            utterance=await reply(app.state.client,LLM,os.getenv('LLM_MODEL','warm-sprout'),history,text,emit)
            await send('status',turn_id=turn,label='准备开口…')
            await actor.speak(app.state.client,TTS,turn,utterance,speech_request(utterance))
            history.extend([dict(role='user',content=text),dict(role='assistant',content=utterance)])
            del history[:-16]
            # Generation completion does not end playback; the client waits for cue_end.
            await send('done',turn_id=turn)
        except asyncio.CancelledError:raise
        except Exception as exc:
            print('CHAT_ERROR',type(exc).__name__,flush=True)
            await send('error',turn_id=turn,message='对话服务暂时没接上，请检查模型连接后重试。')
    try:
        await send('hello',portrait=PORTRAIT)
        while True:
            raw=await ws.receive_text()
            if len(raw)>4_100_000:
                await ws.close(code=1009);break
            try:
                data=json.loads(raw)
                if not isinstance(data,dict):raise ValueError()
                kind=data.get('type')
                if kind=='ping':await send('pong');continue
                if kind=='actor_start':
                    try:await actor.ensure()
                    except Exception:await send('actor_error',message='人物服务尚未就绪，请检查模型连接后重试。')
                elif kind in ('cancel','reset'):
                    previous=active;await cancel()
                    if kind=='reset':history.clear()
                    await send('cancelled',turn_id=previous)
                elif kind in ('text','audio'):
                    turn=data.get('turn_id')
                    if not isinstance(turn,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}',turn):raise ValueError()
                    text=data.get('text')
                    if kind=='text' and (not isinstance(text,str) or not text.strip() or len(text)>1500):raise ValueError()
                    audio=audio_payload(data.get('audio')) if kind=='audio' else None
                    await cancel();active=turn
                    task=asyncio.create_task(run(turn,text.strip() if kind=='text' else None,audio))
                else:await send('error',message='不支持的消息类型。')
            except (ValueError,TypeError,KeyError,wave.Error):
                await send('error',message='输入格式不正确，请重试。')
    except WebSocketDisconnect:pass
    finally:
        await cancel();await actor.close()

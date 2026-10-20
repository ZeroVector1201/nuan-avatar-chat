"""A single conversational LLM call. No assessment or interview controller."""
import json,os

SYSTEM_PROMPT = (
    '你是暖暖，一位温和、友善的 AI 对话伙伴。用自然的中文陪用户聊天，'
    '直接回应对方正在说的事情，并记住上下文。表达简洁，通常一到三句话。'
    '体会对方的感受，但不要机械复述或假定对方没有表达的情绪。'
    '顺着用户想聊的内容交流，不安排访谈流程，不连续盘问细节，也不强行换话题。'
    '需要提问时只问一个自然的问题；没有必要时可以只回应。'
    '坦诚自己是 AI，不冒充真人或专业诊断者。'
)
VOICE_STYLE = (
    '用温柔、亲切、真诚的成年女性声音说话，像一位耐心倾听的知心姐姐。'
    '固定同一种音色、中等偏舒缓的基准语速和自然音量。用日常聊天的口吻，'
    '随句意保留自然的重音、轻微语调起伏和呼吸停顿，疑问句轻轻上扬。'
    '关切但不夸张，不用播音腔，不机械逐字念，不刻意耳语或撒娇，不模仿其他角色。'
)

def messages(history,text):
    return [{'role':'system','content':SYSTEM_PROMPT},*history[-16:],{'role':'user','content':text}]

async def reply(client,url,model,history,text,emit):
    headers={'Authorization':'Bearer '+os.environ['LLM_API_KEY']} if os.getenv('LLM_API_KEY') else {}
    body=dict(model=model,messages=messages(history,text),stream=True,max_tokens=220,temperature=.7,top_p=.8,
              chat_template_kwargs={'enable_thinking':False})
    output=''
    async with client.stream('POST',url+'/v1/chat/completions',json=body,headers=headers) as response:
        response.raise_for_status()
        async for line in response.aiter_lines():
            if not line.startswith('data:'):continue
            raw=line[5:].strip()
            if raw=='[DONE]':break
            data=json.loads(raw);choices=data.get('choices') or []
            if not choices:continue
            token=choices[0].get('delta',{}).get('content') or ''
            if not token:continue
            output+=token
            if len(output)>4000:raise ValueError('Reply too long')
            await emit(output)
    if not output.strip():raise ValueError('Empty reply')
    return output.strip()

def speech_request(text):
    # One fixed voice and one streaming synthesis for the entire response.
    return dict(input=text,task_type='CustomVoice',voice='serena',instructions=VOICE_STYLE,language='Chinese',
                stream=True,stream_format='audio',response_format='pcm',speed=1.0,seed=3407,
                initial_codec_chunk_frames=12,max_new_tokens=min(480,max(140,len(text)*4+36)))

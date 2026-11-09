// template literal at char 1024091..1026428  body length 2336  glsl-marker-hits 5
// context before: "}}function Nz(){const s=new rt;return s.setAttribute(\"position\",new De([-.5,-.5,0,.5,-.5,0,.5,.5,0,-.5,.5,0],3)),s.setAttribute(\"uv\",new De([0,0,1,0,1,1,0,1],2)),s.setAttribute(\"normal\",new De([0,0,1,0,0,1,0,0,1,0,0,1],3)),s.setIndex([0,1,2,0,2,3]),s}const Oz="
// context after : ";function Ea(s,e){const t=s.length;if(t===0)return 0;if(e<=s[0][0])return s[0][1];if(e>=s[t-1][0])return s[t-1][1];let n=1;for(;n<t-1&&s[n][0]<e;)n++;const i=s[n-1],r=s[n],o=r[0]-i[0];if(o<=0)return "
// ======================================================================

#include <common>
uniform float Q309;uniform vec3 Q207;uniform float Q177,Q175,Q154,Q308;attribute vec3 Q56;attribute vec3 Q50;attribute vec3 Q51;attribute vec3 Q52;attribute vec4 Q53;attribute vec4 Q55;attribute vec4 Q54;varying vec2 vUv;varying vec2 Q322;varying vec4 Q315;varying vec3 Q326;varying vec3 Q325;varying vec4 vColor;
#ifdef Q31
attribute vec4 tangent;varying vec4 Q327;
#endif
float R185(float R217,float size){float R220=R217*2.0/projectionMatrix[0][0];return clamp(size,Q177*R220,Q175*R220);}void main(){vec3 R56=(modelMatrix*vec4(Q56,1.0)).xyz;vec3 right=vec3(viewMatrix[0][0],viewMatrix[1][0],viewMatrix[2][0]);vec3 up=vec3(viewMatrix[0][1],viewMatrix[1][1],viewMatrix[2][1]);vec3 back=vec3(viewMatrix[0][2],viewMatrix[1][2],viewMatrix[2][2]);vec3 world;vec3 R136;vec2 corner;
#if defined(Q33)
float depth=max(-(viewMatrix*vec4(R56,1.0)).z,1e-4);vec2 size=vec2(R185(depth,Q50.x),R185(depth,Q50.y));vec2 c=(position.xy-Q207.xy)*size;float s=sin(Q50.z);float k=cos(Q50.z);c=vec2(c.x*k+c.y*s,-c.x*s+c.y*k);world=R56+right*c.x+up*c.y-back*Q207.z*size.x;R136=back;corner=uv;
#elif defined(Q30)
vec3 R153=(viewMatrix*vec4(R56,1.0)).xyz;vec3 R222=(viewMatrix*vec4(Q51,0.0)).xyz;float size=R185(max(-R153.z,1e-4),Q50.x);float R194=dot(R222,R222);vec3 R73=R153;vec2 delta=vec2(1.0,0.0);if(R194>1e-10){R73=R153-R222*(Q308+inversesqrt(R194)*Q154*Q50.x);delta=vec2(R153.z*R73.y-R153.y*R73.z,R153.x*R73.z-R153.z*R73.x);float R64=length(delta);delta=R64>1e-10?delta/R64:vec2(1.0,0.0);}vec3 p=mix(R153,R73,position.x+0.5)+vec3(delta,0.0)*(position.y*size);world=(inverse(viewMatrix)*vec4(p,1.0)).xyz;R136=back;corner=vec2(position.x+0.5,position.y+0.5);
#elif defined(Q29)
vec3 q=position-Q207;world=R56+Q50*q.x+Q51*q.y+Q52*q.z;R136=normalize(cross(Q50,Q51));corner=uv;
#else
vec3 q=position-Q207;world=R56+Q50*q.x+Q51*q.y+Q52*q.z;R136=normalize(mat3(Q50,Q51,Q52)*normal);
#ifdef Q31
float handed=dot(cross(Q50,Q51),Q52)<0.0? -1.0:1.0;Q327=vec4(normalize(mat3(Q50,Q51,Q52)*tangent.xyz),tangent.w*handed);
#endif
corner=vec2(uv.x,1.0-uv.y);
#endif
vUv=Q55.xy+corner*Q55.zw;
#ifdef Q32
Q322=vUv;
#else
Q322=vec2(0.0);
#endif
Q315=Q54;vColor=Q53;vec3 R199=cameraPosition-world;float d=length(R199);world+=R199/max(d,1e-6)*(min(max(d-1.0,0.0),Q309)+0.001);Q326=world;Q325=R136;gl_Position=projectionMatrix*viewMatrix*vec4(world,1.0);}


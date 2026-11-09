// template literal at char 954689..956094  body length 1404  glsl-marker-hits 10
// context before: "ctNormal);\n#endif\ngl_Position=projectionMatrix*viewMatrix*R227;\n#ifdef Q45\nQ314=gl_Position;Q318=(modelMatrix*vec4(0.0,0.0,0.0,1.0)).xyz;Q313=projectionMatrix[1][1]/projectionMatrix[0][0];Q316=projectionMatrix[3][2]/(projectionMatrix[2][2]-1.0);\n#endif\n}\n`,ST="
// context after : ",L4=`\nuniform sampler2D Q163;uniform sampler2D Q172;uniform sampler2D Q79;uniform sampler2D Q112;uniform vec4 Q165,Q162,Q160,Q161;uniform vec4 Q174,Q171,Q169,Q170;uniform vec4 Q82,Q78,Q76,Q77;uniform"
// ======================================================================

#include <common>
uniform float Q284;varying vec2 vUv;varying vec3 Q326;varying vec3 Q325;varying vec4 vColor;
#ifdef Q28
varying vec2 Q322;varying vec4 Q315;
#define Q37 Q322
#define Q34 Q315
#else
#define Q37 vec2(0.0)
#define Q34 vec4(0.0)
#endif
vec2 R189(vec4 R32,vec4 speed,vec4 R22,vec4 R31,vec2 R169,float custom){vec2 uv=R32.x*vUv+R32.y*Q37+R32.w*R169+speed.xy*Q284+speed.zw*custom-0.5;uv=vec2(uv.x*R22.x+uv.y*R22.z,uv.x*R22.y+uv.y*R22.w)+0.5;return uv*R31.xy+R31.zw;}vec2 R189(vec4 R32,vec4 speed,vec4 R22,vec4 R31,vec2 R169){return R189(R32,speed,R22,R31,R169,0.0);}vec4 R166(sampler2D t,vec2 uv){return texture2D(t,vec2(uv.x,1.0-uv.y));}vec4 R47(vec4 t,float on){return mix(t,vec4(1.0,1.0,1.0,t.r),on);}vec2 R63(vec4 t,float R49,float R134,float R207,float R216){float s=t.x*(1.0+R49)-R49;return R134!=0.0?(vec2(s*t.a,t.y)*2.0-1.0)*R207:s*vec2(R207,R216);}uniform float Q297;uniform float Q181;uniform float Q179;uniform float Q182;uniform float Q180;float R132(){if(Q297==0.0)return 1.0;float z=abs((viewMatrix*vec4(Q326,1.0)).z);return clamp((z-Q181)/(Q179-Q181),0.0,1.0)*clamp((z-Q182)/(Q180-Q182),0.0,1.0);}uniform float Q75;void R228(vec3 rgb,float a){rgb=clamp(rgb,0.0,1000.0);gl_FragColor=vec4(rgb,1.0);
#include <tonemapping_fragment>
#include <colorspace_fragment>
vec3 R139=gl_FragColor.rgb*a;
#ifdef Q2
if(Q75==2.0)R139+=1.0-a;
#endif
gl_FragColor=vec4(R139,a*max(1.0-Q75,0.0));}


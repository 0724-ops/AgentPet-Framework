// template literal at char 953426..954684  body length 1257  glsl-marker-hits 4
// context before: "ader:(t==null?void 0:t.vertexShader)??MT,fragmentShader:ST+D4});return a&&(g.onBeforeRender=x4),vT(g,m,{...B0(d),...B0(f),...dc(\"_MainTex\",Bf,\"_MainTex\"),...v,_TintColor:\"Q287\",_BlendTint:\"Q80\",_DissolveEmissiveColor:\"Q103\",_FresnelColor:\"Q136\"},h),g}const MT="
// context after : ",ST=`\n#include <common>\nuniform float Q284;varying vec2 vUv;varying vec3 Q326;varying vec3 Q325;varying vec4 vColor;\n#ifdef Q28\nvarying vec2 Q322;varying vec4 Q315;\n#define Q37 Q322\n#define Q34 Q315\n"
// ======================================================================

#include <common>
#include <skinning_pars_vertex>
uniform float Q309;varying vec2 vUv;varying vec3 Q326;varying vec3 Q325;varying vec4 vColor;
#ifdef Q45
varying vec4 Q314;varying vec3 Q318;varying float Q313;varying float Q316;
#endif
void main(){vUv=vec2(uv.x,1.0-uv.y);
#if defined(USE_COLOR_ALPHA)
vColor=color;
#elif defined(USE_COLOR)
vColor=vec4(color,1.0);
#else
vColor=vec4(1.0);
#endif
vec3 objectNormal=vec3(normal);
#include <skinbase_vertex>
#include <skinnormal_vertex>
#include <begin_vertex>
#include <skinning_vertex>
vec4 R227=modelMatrix*vec4(transformed,1.0);R227.xyz+=normalize(cameraPosition-R227.xyz)*(Q309+0.001);Q326=R227.xyz;
#ifdef Q40
mat3 m3=mat3(modelMatrix);vec3 rows=vec3(dot(vec3(m3[0][0],m3[1][0],m3[2][0]),vec3(m3[0][0],m3[1][0],m3[2][0])),dot(vec3(m3[0][1],m3[1][1],m3[2][1]),vec3(m3[0][1],m3[1][1],m3[2][1])),dot(vec3(m3[0][2],m3[1][2],m3[2][2]),vec3(m3[0][2],m3[1][2],m3[2][2])));Q325=normalize(m3*(objectNormal/rows));
#else
Q325=normalize(mat3(modelMatrix)*objectNormal);
#endif
gl_Position=projectionMatrix*viewMatrix*R227;
#ifdef Q45
Q314=gl_Position;Q318=(modelMatrix*vec4(0.0,0.0,0.0,1.0)).xyz;Q313=projectionMatrix[1][1]/projectionMatrix[0][0];Q316=projectionMatrix[3][2]/(projectionMatrix[2][2]-1.0);
#endif
}


// template literal at char 925019..925454  body length 434  glsl-marker-hits 4
// context before: "lude <skinbase_vertex>\n#include <skinnormal_vertex>\n#include <begin_vertex>\n#include <skinning_vertex>\nvec4 R227=modelMatrix*vec4(transformed,1.0);Q326=R227.xyz;Q325=normalize(mat3(modelMatrix)*objectNormal);gl_Position=projectionMatrix*viewMatrix*R227;}\n`,d4="
// context after : ",f4=`\n#define Q25 ${bx}\n#if defined(Q6) && defined(Q9)\n#define Q0\n#endif\nuniform int Q60;uniform vec4 Q63[Q25];uniform vec4 Q58[Q25];uniform vec4 Q61[Q25];uniform vec4 Q59[Q25];uniform vec4 Q62[Q25];"
// ======================================================================

#if defined(Q5) && defined(Q7)
uniform vec4 Q147;uniform vec4 Q148;uniform float Q149;uniform mat3 Q150;vec3 R96;vec4 R90;float R87;float R92;vec3 R93(vec3 R5){float x=dot(R96,R5);float s=max(sqrt(max(1.0-x*x,0.0)),1e-4);float u=clamp(R90.g*exp2(200.0*log2(s)),0.0,1.0);float v=x>0.0?R87*R87:0.0;
#ifdef Q22
vec3 tint=texture2D(Q277,clamp(vec2(u,1.0-v),0.002,0.998)).rgb;
#else
vec3 tint=vec3(1.0);
#endif
return tint*u*R87;}
#endif


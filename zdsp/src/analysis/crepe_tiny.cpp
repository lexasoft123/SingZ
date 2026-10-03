#include <zdsp/analysis/crepe_tiny.h>
#include <zdsp/analysis/pitch_harmonics.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <fstream>
#include <filesystem>
#include <stdexcept>
#include <vector>
#if defined(__APPLE__) && !defined(SINGZ_CREPE_PORTABLE)
#include <Accelerate/Accelerate.h>
#endif

namespace zdsp::analysis {
namespace {
// Row-major W[out,k] × columns[k,time]. The portable inner loop has independent
// lanes so clang/MSVC can vectorize it; Apple uses its platform BLAS. No worker
// pool or model runtime is owned by this detector.
void multiply(const float* weights, const float* columns, float* out,
              int rows, int count, int inner) {
#if defined(__APPLE__) && !defined(SINGZ_CREPE_PORTABLE)
  cblas_sgemm(CblasRowMajor,CblasNoTrans,CblasNoTrans,rows,count,inner,
              1,weights,inner,columns,count,0,out,count);
#else
  std::fill(out,out+rows*count,0.f);
  for(int r=0;r<rows;++r)
    for(int k=0;k<inner;++k) {
      const float w=weights[r*inner+k];
      const float* source=columns+k*count;
      float* destination=out+r*count;
      for(int t=0;t<count;++t) destination[t]+=w*source[t];
    }
#endif
}
struct Layer {
  int in=0,out=0,kernel=0,stride=0,pad=0;
  std::vector<float> weights,bias,scale,offset;
};
void readFloats(std::ifstream& file,std::vector<float>& values,size_t count) {
  values.resize(count);
  for(float& value:values) {
    unsigned char bytes[4];
    if(!file.read(reinterpret_cast<char*>(bytes),4)) throw std::runtime_error("Truncated CREPE weights");
    const uint32_t bits=uint32_t(bytes[0])|uint32_t(bytes[1])<<8|uint32_t(bytes[2])<<16|uint32_t(bytes[3])<<24;
    std::memcpy(&value,&bits,4);
    if(!std::isfinite(value)) throw std::runtime_error("Invalid CREPE weights");
  }
}
}
struct CrepeTiny::Impl {
  std::array<Layer,6> layers;
  std::vector<float> dense,bias,columns,convolved,current,next;
  std::array<float,360> probabilities{};
  explicit Impl(const std::string& path) {
    std::ifstream file(std::filesystem::path(std::u8string(path.begin(),path.end())),std::ios::binary);
    char magic[8];
    if(!file.read(magic,8)||std::memcmp(magic,"SZCRPT01",8)) throw std::runtime_error("Invalid CREPE model format");
    const int channels[]={1,128,16,16,16,32,64};
    for(int i=0;i<6;++i) {
      auto& l=layers[i]; l.in=channels[i];l.out=channels[i+1];
      l.kernel=i==0?512:64;l.stride=i==0?4:1;l.pad=i==0?254:31;
      readFloats(file,l.weights,l.in*l.out*l.kernel);
      readFloats(file,l.bias,l.out);readFloats(file,l.scale,l.out);readFloats(file,l.offset,l.out);
    }
    readFloats(file,dense,360*256);readFloats(file,bias,360);
    if(file.peek()!=std::char_traits<char>::eof()) throw std::runtime_error("Unexpected CREPE model data");
    columns.resize(128*64*128);convolved.resize(128*256);
    current.resize(128*128);next.resize(128*128);
  }
  void infer(const float* input) {
    std::copy(input,input+1024,current.begin());int length=1024;
    for(const auto& l:layers) {
      const int count=length/l.stride,inner=l.in*l.kernel;
      for(int c=0;c<l.in;++c)for(int k=0;k<l.kernel;++k)for(int t=0;t<count;++t) {
        const int x=t*l.stride+k-l.pad;
        columns[(c*l.kernel+k)*count+t]=x>=0&&x<length?current[c*length+x]:0.f;
      }
      multiply(l.weights.data(),columns.data(),convolved.data(),l.out,count,inner);
      for(int c=0;c<l.out;++c)for(int t=0;t<count/2;++t) {
        // ReLU precedes BN in the original model. A negative BN scale means
        // pooling before BN would change the network, so preserve this order.
        const float a=l.scale[c]*std::max(0.f,convolved[c*count+2*t]+l.bias[c])+l.offset[c];
        const float b=l.scale[c]*std::max(0.f,convolved[c*count+2*t+1]+l.bias[c])+l.offset[c];
        next[c*(count/2)+t]=std::max(a,b);
      }
      current.swap(next);length=count/2;
    }
    // Final ONNX transpose flattens time before channel.
    for(int t=0;t<4;++t)for(int c=0;c<64;++c) columns[t*64+c]=current[c*4+t];
    multiply(dense.data(),columns.data(),convolved.data(),360,1,256);
    for(int i=0;i<360;++i) probabilities[i]=1.f/(1.f+std::exp(-(convolved[i]+bias[i])));
  }
};
CrepeTiny::CrepeTiny(const std::string& path):impl_(std::make_unique<Impl>(path)){}
CrepeTiny::~CrepeTiny()=default;
const std::array<float,360>& CrepeTiny::probabilities() const { return impl_->probabilities; }
zdsp::analysis::LiveInputFrame CrepeTiny::analyze(const float* pcm, size_t frames, double rate) {
  if (!pcm || frames != 1024 || rate != 16000) throw std::runtime_error("Invalid CREPE-tiny analysis window");
  harmonicCorrected = false;
  auto began = std::chrono::steady_clock::now();
  zdsp::analysis::LiveInputFrame result{};
  std::array<float,1024> input{};
  double mean = 0, energy = 0;
  for (size_t i=0;i<frames;++i) { mean += pcm[i]; energy += double(pcm[i])*pcm[i]; result.peak = std::max(result.peak, std::abs(double(pcm[i]))); }
  mean /= frames;
  result.rms = std::sqrt(energy / frames);
  result.dbfs = result.rms > 0 ? std::max(-120.,20*std::log10(result.rms)) : -120;
  // CREPE can be confident on silence. Gate before per-frame normalization.
  if (result.rms < 0.0018) { impl_->probabilities.fill(0); inferenceMs = 0; return result; }
  double variance = 0;
  for (size_t i=0;i<frames;++i) variance += (pcm[i]-mean)*(pcm[i]-mean);
  const double stddev = std::max(1e-8, std::sqrt(variance/frames));
  for (size_t i=0;i<frames;++i) input[i] = float((pcm[i]-mean)/stddev);
  impl_->infer(input.data());
  const float* probabilities = impl_->probabilities.data();
  // Original CREPE local weighted-average decoding, restricted to singing
  // range. No full-sequence Viterbi or future audio is buffered.
  int best = -1;
  for (int i=0;i<360;++i) {
    double hz = 10*std::pow(2.,(1997.3794084376191+20*i)/1200.);
    if (hz >= 55 && hz <= 1050 && (best<0 || probabilities[i]>probabilities[best])) best=i;
  }
  if (best >= 0) {
    result.clarity = probabilities[best];
    double weighted=0, total=0;
    for (int i=std::max(0,best-4); i<=std::min(359,best+4);++i) {
      weighted += probabilities[i]*(1997.3794084376191+20*i);
      total += probabilities[i];
    }
    if (result.clarity >= 0.5 && total > 0)
      result.frequency = 10*std::pow(2.,weighted/total/1200.);
  }
  const int fullBest = static_cast<int>(std::max_element(probabilities, probabilities+360)-probabilities);
  const double fullHz = 10*std::pow(2.,(1997.3794084376191+20*fullBest)/1200.);
  const double corrected = singz::pitch::correctHarmonic(pcm,frames,rate,result.frequency,fullHz,probabilities[fullBest]);
  harmonicCorrected = corrected != result.frequency;
  if (harmonicCorrected) {
    result.frequency = corrected;
    result.clarity = probabilities[fullBest];
  }
  inferenceMs = std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-began).count();
  return result;
}

} // namespace zdsp::analysis

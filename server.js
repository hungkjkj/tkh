const express = require('express');
const ccxt = require('ccxt');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));


// --- THƯ VIỆN TOÁN HỌC (MATHLAB) ---
const MathLab = {
    mean: (arr) => arr.reduce((a, b) => a + b, 0) / arr.length,
    std: (arr, meanVal) => Math.sqrt(arr.reduce((sq, n) => sq + Math.pow(n - meanVal, 2), 0) / arr.length),
    
    // Hồi quy tuyến tính (Linear Regression): y = ax + b
    linearRegression: (yValues) => {
        let n = yValues.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
        for (let i = 0; i < n; i++) {
            sumX += i;
            sumY += yValues[i];
            sumXY += i * yValues[i];
            sumXX += i * i;
        }
        let slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX + 0.00001); // Thêm epsilon để tránh chia cho 0
        let intercept = (sumY - slope * sumX) / n;
        return { slope, intercept };
    },

    // True Range & ATR
    atr: (highs, lows, closes, period) => {
        let trs = [];
        for (let i = 1; i < closes.length; i++) {
            let hl = highs[i] - lows[i];
            let hc = Math.abs(highs[i] - closes[i - 1]);
            let lc = Math.abs(lows[i] - closes[i - 1]);
            trs.push(Math.max(hl, hc, lc));
        }
        // Lấy trung bình TR của mốc A
        return MathLab.mean(trs.slice(-period)); 
    }
};

// --- API TÍNH TOÁN VÀ TRẢ DỮ LIỆU ---
app.post('/api/analyze', async (req, res) => {
    try {
        // 1. Nhận data trực tiếp từ Frontend gửi lên
        const { symbol, timeframe, periodA, periodB, klines } = req.body;
        
        // 2. Ném nguyên cục data vào rổ ohlcv
        let ohlcv = klines;

        if (!ohlcv || ohlcv.length === 0) {
            return res.status(400).json({ error: "Backend không nhận được nến nào từ Frontend!" });
        }

        // 3. Vứt bỏ cây nến chưa đóng
        if (ohlcv.length > 0) {
            ohlcv.pop(); 
        }

        const len = ohlcv.length;
        if (len < periodA + periodB) return res.status(400).json({ error: "Không đủ nến" });

        // TÁCH CỬA SỔ DỮ LIỆU (Cách ly B khỏi A)
        // Cửa sổ B (Trigger): Nến mới nhất
        const windowB = ohlcv.slice(len - periodB, len);
        // Cửa sổ A (Context): Nến ngay trước B
        const windowA = ohlcv.slice(len - periodB - periodA, len - periodB);

        // Bóc tách mảng A
        const closesA = windowA.map(d => d[4]);
        const volumesA = windowA.map(d => d[5]);
        const highsA = windowA.map(d => d[2]);
        const lowsA = windowA.map(d => d[3]);

        // Bóc tách mảng B
        const closesB = windowB.map(d => d[4]);
        const volumesB = windowB.map(d => d[5]);
        const openB_start = windowB[0][1];
        const closeB_end = windowB[windowB.length - 1][4];

        // Cửa sổ B liền kề trước đó (Để tính Vol Accel)
        const windowPrevB = ohlcv.slice(len - periodB * 2, len - periodB);
        const volumesPrevB = windowPrevB.map(d => d[5]);

        // --- 1. TÍNH TOÁN CÁC CHỈ BÁO THEO TÀI LIỆU ---
        
        // 1. Price Location (Z-score): Loại bỏ B, chỉ dùng A [cite: 5]
        const meanA = MathLab.mean(closesA);
        const stdA = MathLab.std(closesA, meanA);
        const zScore = stdA === 0 ? 0 : (closeB_end - meanA) / stdA;

        // 2. Volatility (%ATR): ATR của A / Giá [cite: 10]
        const atrA = MathLab.atr(
            ohlcv.slice(len - periodB - periodA - 20, len - periodB).map(d => d[2]),
            ohlcv.slice(len - periodB - periodA - 20, len - periodB).map(d => d[3]),
            ohlcv.slice(len - periodB - periodA - 20, len - periodB).map(d => d[4]),
            periodA
        );
        const pctATR = (atrA / closeB_end) * 100;

        // 3. Drift (Độ dốc Hồi quy tuyến tính chuẩn hóa) [cite: 6]
        const { slope, intercept } = MathLab.linearRegression(closesA);
        const normSlope = atrA === 0 ? 0 : slope / atrA;

        // --- 4. Efficiency (B window) & Z-Score của Efficiency ---
        const totalVolB = volumesB.reduce((a, b) => a + b, 0);
        // Hàm tính Efficiency cho 1 cửa sổ bất kỳ (Lấy ĐỘ LỚN TUYỆT ĐỐI)
        const getEfficiency = (endIdx, length) => {
            const startIdx = endIdx - length + 1;
            const startOpen = ohlcv[startIdx][1];
            const endClose = ohlcv[endIdx][4];
            
            let totalVol = 0;
            for(let k = startIdx; k <= endIdx; k++) {
                totalVol += ohlcv[k][5];
            }
            
            if (totalVol === 0) return 0;
            // Áp dụng Math.abs() để lấy độ lớn tuyệt đối theo yêu cầu
            return Math.abs(endClose - startOpen) / totalVol; 
        };

        // Tính Efficiency hiện tại của cửa sổ B
        const currentIdx = len - 1;
        const efficiencyB = getEfficiency(currentIdx, periodB);

        // Lăn cửa sổ B qua toàn bộ giai đoạn A để lấy lịch sử (Normalize vs A history)
        let effHistoryA = [];
        const startOfA = len - periodB - periodA;
        const endOfA = len - periodB - 1;

        for (let i = startOfA; i <= endOfA; i++) {
            effHistoryA.push(getEfficiency(i, periodB));
        }

        // Tính Z-Score cho Độ hiệu quả
        const meanEffA = MathLab.mean(effHistoryA);
        const stdEffA = MathLab.std(effHistoryA, meanEffA);
        const zScoreEffB = stdEffA === 0 ? 0 : (efficiencyB - meanEffA) / stdEffA;

        // 5. Volume Acceleration [cite: 8]
        const totalVolPrevB = volumesPrevB.reduce((a, b) => a + b, 0);
        const volAccel = totalVolPrevB === 0 ? 0 : totalVolB / totalVolPrevB;

        // 6. Relative Volume (RVOL) [cite: 9]
        const meanVolA = MathLab.mean(volumesA);
        const rvol = meanVolA === 0 ? 0 : totalVolB / meanVolA; // Cập nhật so với B thay vì mean của B để thấy rõ sự bùng nổ

        // 7. Compression Score [cite: 11]
        const bRange = Math.max(...windowB.map(d => d[2])) - Math.min(...windowB.map(d => d[3]));
        // Điểm nén: Độ dốc thấp + %ATR thấp + Biên độ B nhỏ
        const compScore = (1 / (Math.abs(normSlope) + 1)) + (1 / (pctATR + 1)) + (1 / (bRange / atrA + 1));

        // --- 2. XÁC ĐỊNH REGIME TRẠNG THÁI ---
        let regime = "Unknown";
        if (Math.abs(normSlope) > 0.5 && Math.abs(zScore) < 2) {
            regime = "DRIFT (Tiếp diễn)"; // 
        } else if (Math.abs(normSlope) < 0.3 && pctATR < 0.2) {
            regime = "COMPRESSION (Nén chặt chờ Breakout)"; // 
        } else if (Math.abs(efficiencyB) > 0 && rvol > 1.5 && bRange > atrA) {
            regime = "EXPANSION (Mở rộng/Đảo chiều)"; // 
        }

        res.json({
            chartData: ohlcv, // Gửi toàn bộ nến để vẽ
            regression: { slope, intercept, startIdx: len - periodB - periodA, length: periodA, stdA: stdA },
            indicators: {
                zScore: zScore.toFixed(2),
                normSlope: normSlope.toFixed(4),
                efficiencyB: (efficiencyB * 100000).toFixed(4), 
                zScoreEffB: zScoreEffB.toFixed(2),
                volAccel: volAccel.toFixed(2),
                rvol: (rvol / periodB).toFixed(2), // Chuẩn hóa rvol trên nến
                pctATR: pctATR.toFixed(3) + '%',
                compScore: compScore.toFixed(2),
                regime: regime
            }
        });

    } catch (error) {
        console.log("========== BÁO ĐỘNG ĐỎ TOÁN HỌC ==========");
        console.error(error); // In toàn bộ lỗi chi tiết ra Terminal
        console.log("===========================================");
        
        return res.status(400).json({ error: "Lỗi tính toán Định lượng: " + error.message });
    }
});

app.listen(port, () => {
    console.log(`🚀 Vũ trụ Quant khởi chạy tại http://localhost:${port}`);
});